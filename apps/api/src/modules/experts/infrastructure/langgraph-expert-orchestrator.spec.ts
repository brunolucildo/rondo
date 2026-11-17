import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { ExpertModelError } from "../domain/expert-errors";
import type { ModelMessage } from "../domain/expert-conversation";
import type { OrchestratorEvent } from "../domain/expert-ports";
import { LangGraphExpertOrchestrator, toExpertModelError } from "./langgraph-expert-orchestrator";
import {
  SCRIPTED_ANSWER,
  SCRIPTED_FAIL_MARKER,
  SCRIPTED_SLOW_MARKER,
  ScriptedChatModel,
} from "./scripted-chat-model";

const MESSAGES: ModelMessage[] = [
  { role: "system", content: "You are a test persona." },
  { role: "user", content: "earlier question" },
  { role: "assistant", content: "earlier answer" },
  { role: "user", content: "the new question" },
];

async function run(
  orchestrator: LangGraphExpertOrchestrator,
  messages = MESSAGES,
  signal?: AbortSignal,
) {
  const events: OrchestratorEvent[] = [];

  for await (const event of orchestrator.answer({
    expertId: "head-coach",
    messages,
    signal: signal ?? new AbortController().signal,
  })) {
    events.push(event);
  }

  return events;
}

const texts = (events: OrchestratorEvent[]) =>
  events.flatMap((event) => (event.type === "text" ? [event.text] : []));

describe("LangGraphExpertOrchestrator (R6)", () => {
  it("streams the model output piece by piece through the graph", async () => {
    const model = new FakeStreamingChatModel({
      chunks: [new AIMessageChunk({ content: "Ola " }), new AIMessageChunk({ content: "mundo" })],
    });
    const events = await run(new LangGraphExpertOrchestrator(model));

    expect(texts(events)).toEqual(["Ola ", "mundo"]);
  });

  it("reports the token usage when the model sends it", async () => {
    const events = await run(new LangGraphExpertOrchestrator(new ScriptedChatModel({})));

    expect(texts(events).join("")).toBe(SCRIPTED_ANSWER);
    expect(events.at(-1)).toMatchObject({ type: "usage" });
  });

  it("is always available", () => {
    expect(new LangGraphExpertOrchestrator(new ScriptedChatModel({})).available).toBe(true);
  });

  it("hands the model the system prompt, the history and the question as typed messages", async () => {
    let received: string[] = [];
    const model = new ScriptedChatModel({
      callbacks: [
        {
          handleChatModelStart: (_llm, messages) => {
            received = (messages[0] ?? []).map(
              (message) => `${message.type}:${String(message.content)}`,
            );
          },
        },
      ],
    });

    await run(new LangGraphExpertOrchestrator(model));

    expect(received).toEqual([
      "system:You are a test persona.",
      "human:earlier question",
      "ai:earlier answer",
      "human:the new question",
    ]);
  });

  it("turns a model failure into an ExpertModelError, hiding the provider's message", async () => {
    const orchestrator = new LangGraphExpertOrchestrator(new ScriptedChatModel({}));
    const failure = run(orchestrator, [
      { role: "user", content: `please ${SCRIPTED_FAIL_MARKER}` },
    ]);

    await expect(failure).rejects.toBeInstanceOf(ExpertModelError);
    await expect(failure).rejects.toMatchObject({ message: "The model could not answer." });
  });

  it("stops calling the model when the signal aborts", async () => {
    const orchestrator = new LangGraphExpertOrchestrator(new ScriptedChatModel({}));
    const controller = new AbortController();
    const collected: OrchestratorEvent[] = [];
    const slow = [{ role: "user", content: `go ${SCRIPTED_SLOW_MARKER}` }] as const;

    await expect(
      (async () => {
        for await (const event of orchestrator.answer({
          expertId: "head-coach",
          messages: slow,
          signal: controller.signal,
        })) {
          collected.push(event);

          if (collected.length === 2) {
            controller.abort();
          }
        }
      })(),
    ).rejects.toBeInstanceOf(ExpertModelError);

    // It stopped long before the 400 pieces of the slow script.
    expect(collected.length).toBeLessThan(10);
  });
});

describe("toExpertModelError", () => {
  it.each([
    [429, true],
    [408, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [404, false],
  ])("status %i retryable=%s", (status, retryable) => {
    expect(toExpertModelError(Object.assign(new Error("provider text"), { status }))).toMatchObject(
      { retryable },
    );
  });

  it("retries failures without an HTTP status (network, timeout)", () => {
    expect(toExpertModelError(new Error("ECONNRESET")).retryable).toBe(true);
    expect(toExpertModelError("weird").retryable).toBe(true);
  });

  it("never carries the provider's message", () => {
    expect(
      toExpertModelError(new Error("prompt echo: SENTINEL-123", { cause: "x" })).message,
    ).not.toContain("SENTINEL-123");
  });

  it("keeps a domain error as it is", () => {
    const error = new ExpertModelError(false);

    expect(toExpertModelError(error)).toBe(error);
  });
});
