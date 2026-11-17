import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../../observability/db-telemetry";
import { decodeCursor } from "../domain/conversation-cursor";
import { ConversationStorageError } from "../domain/expert-errors";
import { PostgresConversationRepository } from "./postgres-conversation.repository";

const USER_ID = "5f1b6c1e-2d3a-4e5f-8a9b-0c1d2e3f4a5b";
const MESSAGE_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

function repositoryWith(response: { rows: unknown[] } | { error: unknown }) {
  const query = vi.fn();

  if ("error" in response) {
    query.mockRejectedValue(response.error);
  } else {
    query.mockResolvedValue({ rows: response.rows } as QueryResult<QueryResultRow>);
  }

  const database = { query, end: vi.fn() } as unknown as DatabaseClient;

  return { repository: new PostgresConversationRepository(database), query };
}

const row = (index: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  role: index % 2 === 1 ? "user" : "assistant",
  content: `message ${index}`,
  status: "complete",
  created_at: new Date(Date.UTC(2026, 10, 17, 12, 0, index)),
  ...overrides,
});

describe("PostgresConversationRepository.listPage", () => {
  it("binds the user, the expert, the cursor and limit + 1, never putting them in the SQL text", async () => {
    const { repository, query } = repositoryWith({ rows: [] });

    await repository.listPage(USER_ID, "head-coach", { limit: 50, before: MESSAGE_ID });

    const [call, text, values] = query.mock.calls[0] as [unknown, string, unknown[]];

    expect(call).toEqual({ operation: "select", collection: "expert_messages" });
    expect(values).toEqual([USER_ID, "head-coach", MESSAGE_ID, 51]);
    expect(text).not.toContain(USER_ID);
    expect(text).not.toContain("head-coach");
    expect(text).not.toContain(MESSAGE_ID);
    expect(text).toContain("c.user_id = $1");
  });

  it("returns the newest rows in chronological order, with no cursor when there are no older ones", async () => {
    // The database returns the newest first.
    const { repository } = repositoryWith({ rows: [row(3), row(2), row(1)] });
    const page = await repository.listPage(USER_ID, "head-coach", { limit: 5, before: null });

    expect(page.messages.map((message) => message.content)).toEqual([
      "message 1",
      "message 2",
      "message 3",
    ]);
    expect(page.nextCursor).toBeNull();
    expect(page.messages[0]).toMatchObject({ role: "user", status: "complete" });
  });

  it("drops the extra row and points the cursor at the oldest message of the page", async () => {
    const { repository } = repositoryWith({ rows: [row(4), row(3), row(2)] });
    const page = await repository.listPage(USER_ID, "head-coach", { limit: 2, before: null });

    expect(page.messages.map((message) => message.content)).toEqual(["message 3", "message 4"]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor as string)).toBe(page.messages[0]?.id);
  });

  it("maps an empty result to an empty page", async () => {
    const { repository } = repositoryWith({ rows: [] });

    await expect(
      repository.listPage(USER_ID, "head-coach", { limit: 50, before: null }),
    ).resolves.toEqual({ messages: [], nextCursor: null });
  });

  it("fails with a fixed message that carries no data when a row is malformed", async () => {
    const { repository } = repositoryWith({ rows: [row(1, { role: "system" })] });
    const failure = await repository
      .listPage(USER_ID, "head-coach", { limit: 50, before: null })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConversationStorageError);
    expect((failure as Error).message).not.toContain("message 1");
  });

  it("wraps a database error without echoing its message", async () => {
    const { repository } = repositoryWith({
      error: Object.assign(new Error("duplicate key value (secret content)"), { code: "23505" }),
    });
    const failure = await repository
      .listPage(USER_ID, "head-coach", { limit: 50, before: null })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConversationStorageError);
    expect((failure as Error).message).toBe("Conversation storage failed: list_messages (23505).");
  });
});

describe("PostgresConversationRepository.listPage: citations", () => {
  it("returns null, an empty list or the four known fields of each citation", async () => {
    const { repository } = repositoryWith({
      rows: [
        row(3, {
          citations: [
            {
              connectionId: MESSAGE_ID,
              sourceName: "plano.pdf",
              page: 2,
              position: 1,
              text: "leaked chunk text",
            },
          ],
        }),
        row(2, { citations: [] }),
        row(1),
      ],
    });
    const page = await repository.listPage(USER_ID, "head-coach", { limit: 5, before: null });

    expect(page.messages.map((message) => message.citations)).toEqual([
      null,
      [],
      [{ connectionId: MESSAGE_ID, sourceName: "plano.pdf", page: 2, position: 1 }],
    ]);
  });

  it("refuses a stored value that is not a list of well-formed citations", async () => {
    const { repository } = repositoryWith({ rows: [row(1, { citations: [{ sourceName: 1 }] })] });

    await expect(
      repository.listPage(USER_ID, "head-coach", { limit: 5, before: null }),
    ).rejects.toThrow("list_messages (UNEXPECTED_RESULT)");
  });
});

describe("PostgresConversationRepository.append", () => {
  it("calls expert_append_message with every value bound and the retention limit of 200", async () => {
    const { repository, query } = repositoryWith({
      rows: [{ message_id: MESSAGE_ID, message_created_at: new Date("2026-11-17T12:00:00.000Z") }],
    });

    await expect(
      repository.append(USER_ID, "physiologist", {
        role: "assistant",
        content: "texto parcial",
        status: "incomplete",
      }),
    ).resolves.toEqual({ id: MESSAGE_ID, createdAt: new Date("2026-11-17T12:00:00.000Z") });
    expect(query).toHaveBeenCalledWith(
      { operation: "rpc", procedure: "expert_append_message" },
      "select message_id, message_created_at from public.expert_append_message($1, $2, $3, $4, $5, $6, $7::jsonb)",
      [USER_ID, "physiologist", "assistant", "texto parcial", "incomplete", 200, null],
    );
  });

  it("binds the citations as JSON, only the four known fields, never a chunk text", async () => {
    const { repository, query } = repositoryWith({
      rows: [{ message_id: MESSAGE_ID, message_created_at: new Date("2026-11-17T12:00:00.000Z") }],
    });
    const citations = [
      { connectionId: MESSAGE_ID, sourceName: "plano.pdf", page: 3, position: 7 },
      { connectionId: USER_ID, sourceName: "notas.md", page: null, position: 0 },
    ];

    await repository.append(USER_ID, "head-coach", {
      role: "assistant",
      content: "resposta",
      status: "complete",
      citations,
    });

    const [, , values] = query.mock.calls[0] as [unknown, string, unknown[]];

    expect(JSON.parse(String(values[6]))).toEqual(citations);
    expect(Object.keys(JSON.parse(String(values[6]))[0] as object).sort()).toEqual([
      "connectionId",
      "page",
      "position",
      "sourceName",
    ]);
  });

  it("stores an empty list as an empty JSON array (the gap), distinct from no citations", async () => {
    const { repository, query } = repositoryWith({
      rows: [{ message_id: MESSAGE_ID, message_created_at: new Date("2026-11-17T12:00:00.000Z") }],
    });

    await repository.append(USER_ID, "head-coach", {
      role: "assistant",
      content: "resposta",
      status: "complete",
      citations: [],
    });

    const [, , values] = query.mock.calls[0] as [unknown, string, unknown[]];

    expect(values[6]).toBe("[]");
  });

  it("fails when the function returns an unexpected shape", async () => {
    const { repository } = repositoryWith({ rows: [] });

    await expect(
      repository.append(USER_ID, "head-coach", { role: "user", content: "oi", status: "complete" }),
    ).rejects.toThrow("append_message (UNEXPECTED_RESULT)");
  });

  it("wraps a database error with the operation and the SQLSTATE only", async () => {
    const { repository } = repositoryWith({
      error: Object.assign(new Error("echoes the content"), { code: "23503" }),
    });

    await expect(
      repository.append(USER_ID, "head-coach", { role: "user", content: "oi", status: "complete" }),
    ).rejects.toThrow("Conversation storage failed: append_message (23503).");
  });
});

describe("PostgresConversationRepository.remove and clear", () => {
  it("removes a message only when it belongs to a conversation of the user", async () => {
    const { repository, query } = repositoryWith({ rows: [] });

    await repository.remove(USER_ID, MESSAGE_ID);

    const [call, text, values] = query.mock.calls[0] as [unknown, string, unknown[]];

    expect(call).toEqual({ operation: "delete", collection: "expert_messages" });
    expect(text).toContain("c.user_id = $2");
    expect(values).toEqual([MESSAGE_ID, USER_ID]);
  });

  it("clears by user and expert, binding both", async () => {
    const { repository, query } = repositoryWith({ rows: [] });

    await repository.clear(USER_ID, "head-coach");

    expect(query).toHaveBeenCalledWith(
      { operation: "delete", collection: "expert_conversations" },
      "delete from public.expert_conversations where user_id = $1 and expert_id = $2",
      [USER_ID, "head-coach"],
    );
  });

  it("wraps failures of both", async () => {
    const { repository } = repositoryWith({ error: new Error("down") });

    await expect(repository.remove(USER_ID, MESSAGE_ID)).rejects.toThrow(ConversationStorageError);
    await expect(repository.clear(USER_ID, "head-coach")).rejects.toThrow(ConversationStorageError);
  });
});
