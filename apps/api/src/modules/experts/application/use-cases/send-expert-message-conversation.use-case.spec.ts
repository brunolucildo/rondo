import { describe, expect, it } from "vitest";
import {
  fails,
  FakeExpertOrchestrator,
  speaks,
  speaksThenFails,
} from "../../../../../test/support/fake-expert-orchestrator";
import { InMemoryConversationRepository } from "../../../../../test/support/in-memory-conversations";
import { ConversationBusyError } from "../../domain/expert-errors";
import type { ExpertAnswerEvent } from "../../domain/expert-ports";
import { InMemoryConversationLock } from "../../infrastructure/in-memory-conversation-lock";
import { SendExpertMessage, type SentExpertMessage } from "./send-expert-message.use-case";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";

function setup(orchestrator = new FakeExpertOrchestrator()) {
  const conversations = new InMemoryConversationRepository();
  const lock = new InMemoryConversationLock();

  return {
    orchestrator,
    conversations,
    lock,
    useCase: new SendExpertMessage(orchestrator, conversations, lock, {
      firstTokenMs: 40,
      totalMs: 200,
    }),
  };
}

const input = (overrides: Partial<Parameters<SendExpertMessage["execute"]>[0]> = {}) => ({
  userId: USER,
  expertId: "head-coach",
  content: "Qual escalação?",
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

describe("SendExpertMessage: the stored conversation (R4)", () => {
  it("sends the persona, the last 20 stored messages and the new question, and stores the answer", async () => {
    const { orchestrator, conversations, useCase } = setup();

    conversations.seed(USER, "head-coach", 30);
    orchestrator.use(speaks(["Resposta ", "final"]));

    await run(useCase, { content: "Nova pergunta" });

    const [call] = orchestrator.calls;

    expect(call?.messages).toHaveLength(22);
    expect(call?.messages[0]?.role).toBe("system");
    expect(call?.messages[1]?.content).toBe("message 11");
    expect(call?.messages[20]?.content).toBe("message 30");
    expect(call?.messages[21]).toEqual({ role: "user", content: "Nova pergunta" });

    const stored = conversations.messages(USER, "head-coach");

    expect(
      stored.slice(-2).map(({ role, content, status }) => ({ role, content, status })),
    ).toEqual([
      { role: "user", content: "Nova pergunta", status: "complete" },
      { role: "assistant", content: "Resposta final", status: "complete" },
    ]);
  });

  it("stores the answer before the last event reaches the caller", async () => {
    const { conversations, useCase } = setup();
    const sent = await useCase.execute(input());
    const storedAtDone: number[] = [];

    for await (const event of sent.events) {
      if (event.type === "done") {
        storedAtDone.push(conversations.messages(USER, "head-coach").length);
      }
    }

    expect(storedAtDone).toEqual([2]);
  });

  it("keeps the conversations of two users apart", async () => {
    const { conversations, useCase } = setup();

    await run(useCase);
    await run(useCase, { userId: OTHER_USER, content: "Outra pessoa" });

    expect(conversations.messages(USER, "head-coach")).toHaveLength(2);
    expect(
      conversations.messages(OTHER_USER, "head-coach").map((message) => message.content),
    ).toEqual(["Outra pessoa", "Fake answer."]);
  });

  it("stores the text received as incomplete when the caller stops mid-stream", async () => {
    const { orchestrator, conversations, useCase } = setup();
    const controller = new AbortController();

    orchestrator.use(() =>
      (async function* () {
        yield { type: "text", text: "meio " } as const;
        yield { type: "text", text: "caminho" } as const;
        await new Promise(() => undefined);
      })(),
    );

    const sent = await useCase.execute(input({ signal: controller.signal }));
    const events: ExpertAnswerEvent[] = [];

    for await (const event of sent.events) {
      events.push(event);

      if (event.type === "text" && event.text === "caminho") {
        controller.abort();
      }
    }

    expect(events.at(-1)).toEqual({ type: "aborted" });
    expect(conversations.messages(USER, "head-coach").at(-1)).toMatchObject({
      role: "assistant",
      content: "meio caminho",
      status: "incomplete",
    });
  });

  it("stores the partial text as incomplete when the model fails after the first token", async () => {
    const { orchestrator, conversations, useCase } = setup();

    orchestrator.use(speaksThenFails(["par", "tial"]));
    await run(useCase);

    expect(conversations.messages(USER, "head-coach").at(-1)).toMatchObject({
      role: "assistant",
      content: "partial",
      status: "incomplete",
    });
  });

  it("gives an incomplete answer to the model as context, as it is", async () => {
    const { orchestrator, conversations, useCase } = setup();

    await conversations.append(USER, "head-coach", {
      role: "assistant",
      content: "resposta pela metade",
      status: "incomplete",
    });
    await run(useCase);

    expect(orchestrator.calls[0]?.messages[1]).toEqual({
      role: "assistant",
      content: "resposta pela metade",
    });
  });

  it("takes the question back when no text arrived, so a retry does not repeat it", async () => {
    const { orchestrator, conversations, useCase } = setup();

    orchestrator.use(fails(false));
    await run(useCase);

    expect(conversations.messages(USER, "head-coach")).toEqual([]);

    orchestrator.use(speaks(["agora sim"]));
    await run(useCase);

    expect(conversations.messages(USER, "head-coach").map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("takes the question back when the caller was already gone, without calling the model", async () => {
    const { orchestrator, conversations, useCase } = setup();
    const controller = new AbortController();

    controller.abort();
    await run(useCase, { signal: controller.signal });

    expect(orchestrator.calls).toHaveLength(0);
    expect(conversations.messages(USER, "head-coach")).toEqual([]);
  });

  it("ends with failed (storage_error) instead of done when the answer cannot be stored", async () => {
    const { conversations, useCase } = setup();
    const sent = await useCase.execute(input());

    // The question is stored already; now the write of the answer fails.
    conversations.failNext = { method: "append", error: new Error("boom") };

    expect((await drain(sent)).at(-1)).toEqual({ type: "failed", reason: "storage_error" });
  });

  it("does not stream when the history cannot be read, and frees the lock", async () => {
    const { orchestrator, conversations, lock, useCase } = setup();

    conversations.failNext = { method: "listPage", error: new Error("down") };

    await expect(useCase.execute(input())).rejects.toThrow("down");
    expect(orchestrator.calls).toHaveLength(0);
    expect(lock.tryAcquire(USER, "head-coach")).not.toBeNull();
  });

  it("does not stream when the question cannot be stored, and frees the lock", async () => {
    const { orchestrator, conversations, lock, useCase } = setup();

    conversations.failNext = { method: "append", error: new Error("down") };

    await expect(useCase.execute(input())).rejects.toThrow("down");
    expect(orchestrator.calls).toHaveLength(0);
    expect(lock.tryAcquire(USER, "head-coach")).not.toBeNull();
  });
});

describe("SendExpertMessage: one answer at a time (R6)", () => {
  it("refuses a second answer of the same user and expert while the first is not done", async () => {
    const { useCase } = setup();
    const first = await useCase.execute(input());

    await expect(useCase.execute(input())).rejects.toThrow(ConversationBusyError);

    await drain(first);
  });

  it("does not block another expert, nor another user", async () => {
    const { useCase } = setup();
    const first = await useCase.execute(input());
    const otherExpert = await useCase.execute(input({ expertId: "physiologist" }));
    const otherUser = await useCase.execute(input({ userId: OTHER_USER }));

    await Promise.all([drain(first), drain(otherExpert), drain(otherUser)]);
  });

  it("frees the lock when the answer ends, fails or is stopped", async () => {
    const { orchestrator, useCase } = setup();

    await run(useCase);
    await run(useCase);

    orchestrator.use(fails(false));
    await run(useCase);
    await run(useCase);

    const controller = new AbortController();

    controller.abort();
    await run(useCase, { signal: controller.signal });
    await expect(run(useCase)).resolves.toBeDefined();
  });

  it("frees the lock when the stream is abandoned half way, and when it was never read", async () => {
    const { orchestrator, useCase } = setup();

    orchestrator.use(speaks(["a", "b", "c"]));

    const abandoned = await useCase.execute(input());

    for await (const event of abandoned.events) {
      if (event.type === "text") {
        break;
      }
    }

    const unread = await useCase.execute(input());

    // The `finally` of the caller: the stream never started, so only `release` can free the lock.
    unread.release();
    unread.release();

    await expect(run(useCase)).resolves.toBeDefined();
  });
});
