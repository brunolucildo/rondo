import { describe, expect, it, vi } from "vitest";
import {
  failsKnowledge,
  FakeExpertOrchestrator,
  speaks,
  speaksThenFails,
  withCitations,
} from "../../../../../test/support/fake-expert-orchestrator";
import { InMemoryConversationRepository } from "../../../../../test/support/in-memory-conversations";
import { ConnectionNotFoundError, ConnectionNotReadyError } from "../../domain/expert-errors";
import type { ConnectionSources, ExpertAnswerEvent } from "../../domain/expert-ports";
import type { Citation } from "../../domain/grounding";
import { InMemoryConversationLock } from "../../infrastructure/in-memory-conversation-lock";
import { SendExpertMessage, type SentExpertMessage } from "./send-expert-message.use-case";

const USER = "11111111-1111-4111-8111-111111111111";
const FILE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FILE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const CITATION: Citation = {
  connectionId: FILE_A,
  sourceName: "plano.pdf",
  page: 2,
  position: 3,
};

/** The sources of the user: which connections are `ready` and which exist but are not. */
function sourcesOf({
  ready = [FILE_A],
  processing = [],
}: { ready?: string[]; processing?: string[] } = {}): ConnectionSources & {
  assertAttachable: ReturnType<typeof vi.fn>;
  hasReadyConnection: ReturnType<typeof vi.fn>;
} {
  return {
    assertAttachable: vi.fn((_userId: string, ids: readonly string[]) => {
      if (ids.some((id) => !ready.includes(id) && !processing.includes(id))) {
        return Promise.reject(new ConnectionNotFoundError());
      }

      return ids.some((id) => processing.includes(id))
        ? Promise.reject(new ConnectionNotReadyError())
        : Promise.resolve();
    }),
    hasReadyConnection: vi.fn(() => Promise.resolve(ready.length > 0)),
  };
}

function setup(sources: ConnectionSources = sourcesOf()) {
  const orchestrator = new FakeExpertOrchestrator();
  const conversations = new InMemoryConversationRepository();
  const useCase = new SendExpertMessage(
    orchestrator,
    conversations,
    new InMemoryConversationLock(),
    { firstTokenMs: 40, totalMs: 200 },
    sources,
  );

  return { orchestrator, conversations, useCase, sources };
}

const input = (overrides: Partial<Parameters<SendExpertMessage["execute"]>[0]> = {}) => ({
  userId: USER,
  expertId: "head-coach",
  content: "Qual a carga da semana 3?",
  signal: new AbortController().signal,
  ...overrides,
});

async function drain(sent: SentExpertMessage): Promise<ExpertAnswerEvent[]> {
  const events: ExpertAnswerEvent[] = [];

  for await (const event of sent.events) {
    events.push(event);
  }

  return events;
}

const run = async (useCase: SendExpertMessage, overrides = {}) =>
  drain(await useCase.execute(input(overrides)));

describe("SendExpertMessage: what is retrieved (R1, R2)", () => {
  it("searches the whole base of the user when there are no connectionIds and a connection is ready", async () => {
    const { orchestrator, useCase } = setup();

    await run(useCase);

    expect(orchestrator.calls[0]?.retrieval).toEqual({
      userId: USER,
      question: "Qual a carga da semana 3?",
      connectionIds: null,
    });
  });

  it("limits the search to the attached connections, once each, after checking them", async () => {
    const { orchestrator, useCase, sources } = setup(sourcesOf({ ready: [FILE_A, FILE_B] }));

    await run(useCase, { connectionIds: [FILE_A, FILE_B, FILE_A] });

    expect(sources.assertAttachable).toHaveBeenCalledWith(USER, [FILE_A, FILE_B]);
    expect(orchestrator.calls[0]?.retrieval?.connectionIds).toEqual([FILE_A, FILE_B]);
  });

  it("treats an empty connectionIds as no attachment", async () => {
    const { orchestrator, useCase, sources } = setup();

    await run(useCase, { connectionIds: [] });

    expect(sources.assertAttachable).not.toHaveBeenCalled();
    expect(orchestrator.calls[0]?.retrieval?.connectionIds).toBeNull();
  });

  it("does not retrieve when the user has no ready connection", async () => {
    const { orchestrator, useCase } = setup(sourcesOf({ ready: [] }));

    await run(useCase);

    expect(orchestrator.calls[0]?.retrieval).toBeNull();
  });

  it("does not retrieve (and keeps working) when no sources are wired", async () => {
    const orchestrator = new FakeExpertOrchestrator();
    const useCase = new SendExpertMessage(
      orchestrator,
      new InMemoryConversationRepository(),
      new InMemoryConversationLock(),
    );

    await run(useCase);

    expect(orchestrator.calls[0]?.retrieval).toBeNull();
  });

  it("refuses an unknown or foreign connection with ConnectionNotFoundError, storing nothing and not calling the model", async () => {
    const { orchestrator, conversations, useCase } = setup();

    await expect(useCase.execute(input({ connectionIds: [FILE_B] }))).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
    expect(orchestrator.calls).toHaveLength(0);
    expect(conversations.messages(USER, "head-coach")).toEqual([]);
  });

  it("refuses a connection that is not ready with ConnectionNotReadyError, and frees the lock", async () => {
    const { orchestrator, useCase } = setup(sourcesOf({ processing: [FILE_B] }));

    await expect(useCase.execute(input({ connectionIds: [FILE_B] }))).rejects.toBeInstanceOf(
      ConnectionNotReadyError,
    );
    await expect(run(useCase)).resolves.toBeDefined();
    expect(orchestrator.calls).toHaveLength(1);
  });
});

describe("SendExpertMessage: the citations (R4, R5)", () => {
  it("stores the citations with the answer and sends them right before done", async () => {
    const { orchestrator, conversations, useCase } = setup();

    orchestrator.use(withCitations([CITATION], speaks(["Resposta ", "final"])));

    const events = await run(useCase);

    expect(events.map((event) => event.type)).toEqual(["text", "text", "citations", "done"]);
    expect(events.find((event) => event.type === "citations")).toEqual({
      type: "citations",
      citations: [CITATION],
    });
    expect(conversations.messages(USER, "head-coach").at(-1)).toMatchObject({
      role: "assistant",
      content: "Resposta final",
      status: "complete",
      citations: [CITATION],
    });
    expect(conversations.messages(USER, "head-coach")[0]?.citations).toBeNull();
  });

  it("stores and sends an empty list for the gap, distinct from no retrieval", async () => {
    const { orchestrator, conversations, useCase } = setup();

    orchestrator.use(withCitations([], speaks(["No source covers this."])));

    const events = await run(useCase);

    expect(events.find((event) => event.type === "citations")).toEqual({
      type: "citations",
      citations: [],
    });
    expect(conversations.messages(USER, "head-coach").at(-1)?.citations).toEqual([]);
  });

  it("sends no citations event and stores null when no retrieval ran", async () => {
    const { conversations, useCase } = setup(sourcesOf({ ready: [] }));
    const events = await run(useCase);

    expect(events.some((event) => event.type === "citations")).toBe(false);
    expect(conversations.messages(USER, "head-coach").at(-1)?.citations).toBeNull();
  });

  it("keeps the citations already retrieved with a partial answer, without sending the event", async () => {
    const { orchestrator, conversations, useCase } = setup();

    orchestrator.use(withCitations([CITATION], speaksThenFails(["par", "tial"])));

    const events = await run(useCase);

    expect(events.some((event) => event.type === "citations")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "failed", reason: "provider_error" });
    expect(conversations.messages(USER, "head-coach").at(-1)).toMatchObject({
      content: "partial",
      status: "incomplete",
      citations: [CITATION],
    });
  });

  it("does not let the citations event count as the first token (the retry still happens)", async () => {
    const { orchestrator, useCase } = setup();
    let calls = 0;

    orchestrator.use((input, attempt) => {
      calls += 1;

      return attempt === 1
        ? withCitations([CITATION], () =>
            (async function* () {
              await Promise.reject(new Error("model failed"));
              yield { type: "text", text: "never" } as const;
            })(),
          )(input, attempt)
        : withCitations([CITATION], speaks(["ok"]))(input, attempt);
    });

    const events = await run(useCase);

    expect(calls).toBe(2);
    expect(events.at(-1)).toEqual({ type: "done", usage: null });
  });
});

describe("SendExpertMessage: the retrieval fails (R8)", () => {
  it("ends with knowledge_unavailable, without a second attempt, and keeps the question", async () => {
    const { orchestrator, conversations, useCase } = setup();

    orchestrator.use(failsKnowledge());

    const events = await run(useCase);

    expect(events).toEqual([{ type: "failed", reason: "knowledge_unavailable" }]);
    expect(orchestrator.calls).toHaveLength(1);
    expect(conversations.messages(USER, "head-coach").map((message) => message.role)).toEqual([
      "user",
    ]);
  });

  it("reuses the stored question when the same text is sent again, instead of repeating it", async () => {
    const { orchestrator, conversations, useCase } = setup();

    orchestrator.use(failsKnowledge());
    await run(useCase);
    orchestrator.use(withCitations([CITATION], speaks(["agora sim"])));
    await run(useCase);

    expect(conversations.messages(USER, "head-coach").map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    // The question is the last message of the model's context once, not twice.
    const userTurns = orchestrator.calls[1]?.messages.filter((message) => message.role === "user");

    expect(userTurns).toHaveLength(1);
  });

  it("stores a new question when the text is different", async () => {
    const { orchestrator, conversations, useCase } = setup();

    orchestrator.use(failsKnowledge());
    await run(useCase);
    orchestrator.use(speaks(["ok"]));
    await run(useCase, { content: "Outra pergunta" });

    expect(conversations.messages(USER, "head-coach").map((message) => message.content)).toEqual([
      "Qual a carga da semana 3?",
      "Outra pergunta",
      "ok",
    ]);
  });

  it("still takes the question back for a model failure before the first token", async () => {
    const { orchestrator, conversations, useCase } = setup();

    orchestrator.use(() =>
      (async function* () {
        await Promise.reject(new Error("down"));
        yield { type: "text", text: "never" } as const;
      })(),
    );
    await run(useCase);

    expect(conversations.messages(USER, "head-coach")).toEqual([]);
  });
});
