import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { chunkOf } from "../../../../../test/support/knowledge-index-contract";
import { KnowledgeIndexUnavailableError } from "../../../knowledge";
import { fakeVectorOf, InMemoryKnowledgeIndex } from "../../../knowledge/testing";
import {
  ConnectionBusyError,
  ConnectionIndexUnavailableError,
  ConnectionNotFoundError,
} from "../../domain/connection-errors";
import type { ConnectionTelemetry } from "../../domain/connection-ports";
import { STALE_PROCESSING_MS } from "../../domain/connection-rules";
import { InMemoryConnectionRepository } from "../../testing/in-memory-connection.repository";
import { DeleteAllConnections } from "./delete-all-connections.use-case";
import { DeleteConnection } from "./delete-connection.use-case";
import { ListConnections } from "./list-connections.use-case";

const USER_ID = randomUUID();
const OTHER_USER_ID = randomUUID();
const SENTINEL = "SENTINEL-file-name-42";

const hashOf = (letter: string) => letter.repeat(64);

function setup(now: () => Date = () => new Date()) {
  const repository = new InMemoryConnectionRepository(now);
  const index = new InMemoryKnowledgeIndex();
  const telemetry: ConnectionTelemetry = {
    traceIngestion: vi.fn(),
    recordDeduplicated: vi.fn(),
    recordDeletion: vi.fn(),
    recordUrlFetch: vi.fn(),
    recordRejected: vi.fn(),
  };

  return {
    repository,
    index,
    telemetry,
    list: new ListConnections(repository),
    remove: new DeleteConnection(repository, index, telemetry, now),
    removeAll: new DeleteAllConnections(repository, index, telemetry, now),
  };
}

type Setup = ReturnType<typeof setup>;

/** A connection of `userId` with one indexed chunk, in the given final state. */
async function connect(
  { repository, index }: Setup,
  userId: string,
  letter: string,
  status: "ready" | "failed" | "processing" = "ready",
  name = `${letter}.txt`,
) {
  const { connection } = await repository.insertProcessing(userId, {
    kind: "txt",
    name,
    sizeBytes: 10,
    contentHash: hashOf(letter),
  });

  if (status === "ready") {
    await repository.markReady(userId, connection.id, 1);
  } else if (status === "failed") {
    await repository.markFailed(userId, connection.id, "NO_EXTRACTABLE_TEXT");
  }

  await index.upsert(userId, [chunkOf(connection.id, 0, `text of ${letter}`)]);

  return connection;
}

/** The chunks of the user whose text is exactly `text` (the fake embedding makes them score ~1). */
const hitsOf = async (index: InMemoryKnowledgeIndex, userId: string, text: string) =>
  (await index.search(userId, fakeVectorOf(text), { limit: 10 })).filter(
    (hit) => hit.score > 0.999,
  );

/** An index that fails on the next deletion calls and then recovers. */
function failingDeletes(index: InMemoryKnowledgeIndex) {
  const state = { failing: true };
  const fail = () => {
    throw new KnowledgeIndexUnavailableError("CONNECTION", true, 3);
  };
  const original = {
    byConnection: index.deleteByConnection.bind(index),
    all: index.deleteAllForUser.bind(index),
  };

  index.deleteByConnection = (userId, connectionId) =>
    state.failing ? Promise.resolve().then(fail) : original.byConnection(userId, connectionId);
  index.deleteAllForUser = (userId) =>
    state.failing ? Promise.resolve().then(fail) : original.all(userId);

  return state;
}

describe("ListConnections (R1)", () => {
  it("lists only the connections of the user, the most recent first", async () => {
    let clock = new Date("2026-11-17T10:00:00Z");
    const context = setup(() => clock);
    const ids: string[] = [];

    for (const letter of ["a", "b", "c"]) {
      clock = new Date(clock.getTime() + 1000);
      ids.push((await connect(context, USER_ID, letter)).id);
    }

    await connect(context, OTHER_USER_ID, "d");
    await connect(context, OTHER_USER_ID, "e");

    const listed = await context.list.execute({ userId: USER_ID });

    expect(listed.map((connection) => connection.id)).toEqual(ids.reverse());
  });

  it("answers an empty list when there is nothing", async () => {
    await expect(setup().list.execute({ userId: USER_ID })).resolves.toEqual([]);
  });
});

describe("DeleteConnection (R2 to R5)", () => {
  it("removes the vectors and then the row, and a repeat is not found", async () => {
    const context = setup();
    const connection = await connect(context, USER_ID, "a");

    await context.remove.execute({ userId: USER_ID, connectionId: connection.id });

    await expect(hitsOf(context.index, USER_ID, "text of a")).resolves.toEqual([]);
    await expect(context.repository.findById(USER_ID, connection.id)).resolves.toBeNull();
    await expect(
      context.remove.execute({ userId: USER_ID, connectionId: connection.id }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it("deletes the vectors before the row", async () => {
    const context = setup();
    const connection = await connect(context, USER_ID, "a");
    const rowAtIndexTime: unknown[] = [];
    const original = context.index.deleteByConnection.bind(context.index);

    context.index.deleteByConnection = async (userId, connectionId) => {
      rowAtIndexTime.push(await context.repository.findById(userId, connectionId));
      await original(userId, connectionId);
    };

    await context.remove.execute({ userId: USER_ID, connectionId: connection.id });

    expect(rowAtIndexTime).toHaveLength(1);
    expect(rowAtIndexTime[0]).not.toBeNull();
  });

  it("keeps the row when the index fails, and repeating finishes the job (R3)", async () => {
    const context = setup();
    const connection = await connect(context, USER_ID, "a");
    const index = failingDeletes(context.index);

    await expect(
      context.remove.execute({ userId: USER_ID, connectionId: connection.id }),
    ).rejects.toBeInstanceOf(ConnectionIndexUnavailableError);
    await expect(context.repository.findById(USER_ID, connection.id)).resolves.not.toBeNull();
    await expect(hitsOf(context.index, USER_ID, "text of a")).resolves.toHaveLength(1);

    index.failing = false;

    await context.remove.execute({ userId: USER_ID, connectionId: connection.id });

    await expect(context.repository.findById(USER_ID, connection.id)).resolves.toBeNull();
    await expect(hitsOf(context.index, USER_ID, "text of a")).resolves.toEqual([]);
  });

  it("finishes a deletion that lost its row but not its vectors (idempotent steps)", async () => {
    const context = setup();
    const connection = await connect(context, USER_ID, "a");
    const index = failingDeletes(context.index);

    await expect(
      context.remove.execute({ userId: USER_ID, connectionId: connection.id }),
    ).rejects.toBeInstanceOf(ConnectionIndexUnavailableError);

    index.failing = false;
    await context.remove.execute({ userId: USER_ID, connectionId: connection.id });
    await expect(
      context.remove.execute({ userId: USER_ID, connectionId: connection.id }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it("answers not found for another user's connection and changes nothing", async () => {
    const context = setup();
    const connection = await connect(context, USER_ID, "a");

    await expect(
      context.remove.execute({ userId: OTHER_USER_ID, connectionId: connection.id }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
    await expect(
      context.remove.execute({ userId: USER_ID, connectionId: randomUUID() }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
    await expect(context.repository.findById(USER_ID, connection.id)).resolves.not.toBeNull();
    await expect(hitsOf(context.index, USER_ID, "text of a")).resolves.toHaveLength(1);
  });

  it("refuses a connection that is processing and changes nothing (R4)", async () => {
    const context = setup();
    const connection = await connect(context, USER_ID, "a", "processing");

    await expect(
      context.remove.execute({ userId: USER_ID, connectionId: connection.id }),
    ).rejects.toBeInstanceOf(ConnectionBusyError);
    await expect(context.repository.findById(USER_ID, connection.id)).resolves.not.toBeNull();
    await expect(hitsOf(context.index, USER_ID, "text of a")).resolves.toHaveLength(1);
  });

  it("deletes a failed connection and one stuck in processing for over 15 minutes (R4)", async () => {
    let clock = new Date("2026-11-17T10:00:00Z");
    const context = setup(() => clock);
    const failed = await connect(context, USER_ID, "a", "failed");
    const stuck = await connect(context, USER_ID, "b", "processing");

    clock = new Date(clock.getTime() + STALE_PROCESSING_MS + 1000);

    await context.remove.execute({ userId: USER_ID, connectionId: failed.id });
    await context.remove.execute({ userId: USER_ID, connectionId: stuck.id });

    await expect(context.list.execute({ userId: USER_ID })).resolves.toEqual([]);
  });

  it("keeps the row and answers busy when the file started processing again meanwhile", async () => {
    const context = setup();
    const connection = await connect(context, USER_ID, "a", "failed");
    const original = context.index.deleteByConnection.bind(context.index);

    // The same file is sent again while the vectors are being removed: `failed` is claimed.
    context.index.deleteByConnection = async (userId, connectionId) => {
      await original(userId, connectionId);
      await context.repository.claimFailed(userId, connectionId);
    };

    await expect(
      context.remove.execute({ userId: USER_ID, connectionId: connection.id }),
    ).rejects.toBeInstanceOf(ConnectionBusyError);
    await expect(context.repository.findById(USER_ID, connection.id)).resolves.not.toBeNull();
  });

  it("forgets the deduplication identity: the same content is a new connection (R5)", async () => {
    const context = setup();
    const connection = await connect(context, USER_ID, "a");

    await context.remove.execute({ userId: USER_ID, connectionId: connection.id });

    const again = await context.repository.insertProcessing(USER_ID, {
      kind: "txt",
      name: "a.txt",
      sizeBytes: 10,
      contentHash: hashOf("a"),
    });

    expect(again.created).toBe(true);
    expect(again.connection.id).not.toBe(connection.id);
  });

  it("leaves the other connections and the other users alone", async () => {
    const context = setup();
    const target = await connect(context, USER_ID, "a");
    const sibling = await connect(context, USER_ID, "b");

    await connect(context, OTHER_USER_ID, "a");
    await context.remove.execute({ userId: USER_ID, connectionId: target.id });

    await expect(context.repository.findById(USER_ID, sibling.id)).resolves.not.toBeNull();
    await expect(hitsOf(context.index, USER_ID, "text of b")).resolves.toHaveLength(1);
    await expect(hitsOf(context.index, OTHER_USER_ID, "text of a")).resolves.toHaveLength(1);
    await expect(context.list.execute({ userId: OTHER_USER_ID })).resolves.toHaveLength(1);
  });

  it("records scope, outcome and duration only (R9)", async () => {
    const context = setup();
    const connection = await connect(context, USER_ID, "a", "ready", `${SENTINEL}.txt`);

    await context.remove.execute({ userId: USER_ID, connectionId: connection.id });
    await context.remove
      .execute({ userId: USER_ID, connectionId: connection.id })
      .catch(() => undefined);

    const calls = vi.mocked(context.telemetry.recordDeletion).mock.calls;

    expect(calls.map(([scope, outcome]) => [scope, outcome])).toEqual([
      ["single", "success"],
      ["single", "not_found"],
    ]);
    expect(JSON.stringify(calls)).not.toContain(SENTINEL);
    expect(JSON.stringify(calls)).not.toContain(connection.id);
    expect(JSON.stringify(calls)).not.toContain(USER_ID);
  });

  it("records an index failure as index_unavailable", async () => {
    const context = setup();
    const connection = await connect(context, USER_ID, "a");

    failingDeletes(context.index);
    await context.remove
      .execute({ userId: USER_ID, connectionId: connection.id })
      .catch(() => undefined);

    expect(vi.mocked(context.telemetry.recordDeletion).mock.calls[0]?.[1]).toBe(
      "index_unavailable",
    );
  });
});

describe("DeleteAllConnections (R6)", () => {
  it("removes the whole tenant and every row of the user, and a repeat succeeds", async () => {
    const context = setup();

    for (const letter of ["a", "b", "c", "d", "e"]) {
      await connect(context, USER_ID, letter);
    }

    await context.removeAll.execute({ userId: USER_ID });

    await expect(context.list.execute({ userId: USER_ID })).resolves.toEqual([]);
    await expect(hitsOf(context.index, USER_ID, "text of a")).resolves.toEqual([]);
    await expect(context.removeAll.execute({ userId: USER_ID })).resolves.toBeUndefined();
  });

  it("leaves the data of another user", async () => {
    const context = setup();

    await connect(context, USER_ID, "a");
    await connect(context, OTHER_USER_ID, "b");
    await context.removeAll.execute({ userId: USER_ID });

    await expect(context.list.execute({ userId: OTHER_USER_ID })).resolves.toHaveLength(1);
    await expect(hitsOf(context.index, OTHER_USER_ID, "text of b")).resolves.toHaveLength(1);
  });

  it("refuses everything while one connection is processing", async () => {
    const context = setup();

    await connect(context, USER_ID, "a");
    await connect(context, USER_ID, "b", "processing");

    await expect(context.removeAll.execute({ userId: USER_ID })).rejects.toBeInstanceOf(
      ConnectionBusyError,
    );
    await expect(context.list.execute({ userId: USER_ID })).resolves.toHaveLength(2);
    await expect(hitsOf(context.index, USER_ID, "text of a")).resolves.toHaveLength(1);
  });

  it("keeps every row when the index fails, and repeating finishes the job", async () => {
    const context = setup();

    await connect(context, USER_ID, "a");
    await connect(context, USER_ID, "b");

    const index = failingDeletes(context.index);

    await expect(context.removeAll.execute({ userId: USER_ID })).rejects.toBeInstanceOf(
      ConnectionIndexUnavailableError,
    );
    await expect(context.list.execute({ userId: USER_ID })).resolves.toHaveLength(2);

    index.failing = false;
    await context.removeAll.execute({ userId: USER_ID });

    await expect(context.list.execute({ userId: USER_ID })).resolves.toEqual([]);
    expect(vi.mocked(context.telemetry.recordDeletion).mock.calls.map((call) => call[1])).toEqual([
      "index_unavailable",
      "success",
    ]);
  });

  it("deletes a connection stuck in processing for over 15 minutes", async () => {
    let clock = new Date("2026-11-17T10:00:00Z");
    const context = setup(() => clock);

    await connect(context, USER_ID, "a", "processing");
    clock = new Date(clock.getTime() + STALE_PROCESSING_MS + 1000);

    await context.removeAll.execute({ userId: USER_ID });

    await expect(context.list.execute({ userId: USER_ID })).resolves.toEqual([]);
  });
});
