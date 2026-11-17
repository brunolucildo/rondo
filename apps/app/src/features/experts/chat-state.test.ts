import { describe, expect, it } from "vitest";
import {
  buildHistory,
  type ChatMessage,
  chatReducer,
  HISTORY_LIMIT,
  MESSAGE_LIMIT,
} from "./chat-state";

const sent = (messages: ChatMessage[], n: number): ChatMessage[] =>
  chatReducer(messages, { type: "sent", userId: `u${n}`, expertId: `a${n}`, content: `q${n}` });

describe("chatReducer", () => {
  it("appends the question and an empty streaming answer", () => {
    expect(sent([], 1)).toEqual([
      { id: "u1", role: "user", content: "q1" },
      { id: "a1", role: "expert", content: "", status: "streaming" },
    ]);
  });

  it("appends deltas to the answer and marks it done", () => {
    let messages = sent([], 1);

    messages = chatReducer(messages, { type: "delta", id: "a1", text: "Ol" });
    messages = chatReducer(messages, { type: "delta", id: "a1", text: "á" });
    messages = chatReducer(messages, { type: "finished", id: "a1" });

    expect(messages[1]).toMatchObject({ content: "Olá", status: "done" });
  });

  it("marks a stopped answer as incomplete and keeps its text", () => {
    let messages = sent([], 1);

    messages = chatReducer(messages, { type: "delta", id: "a1", text: "meio" });
    messages = chatReducer(messages, { type: "stopped", id: "a1" });

    expect(messages[1]).toMatchObject({ content: "meio", status: "incomplete" });
  });

  it("turns a failure with text into an incomplete answer, and one without into an error", () => {
    const withText = chatReducer(chatReducer(sent([], 1), { type: "delta", id: "a1", text: "x" }), {
      type: "failed",
      id: "a1",
      status: "error",
    });
    const withoutText = chatReducer(sent([], 1), { type: "failed", id: "a1", status: "error" });

    expect(withText[1]).toMatchObject({ status: "incomplete", content: "x" });
    expect(withoutText[1]).toMatchObject({ status: "error", content: "" });
  });

  it("keeps the unavailable and rate-limited statuses as they are", () => {
    const unavailable = chatReducer(sent([], 1), {
      type: "failed",
      id: "a1",
      status: "unavailable",
    });
    const limited = chatReducer(sent([], 1), { type: "failed", id: "a1", status: "rate-limited" });

    expect(unavailable[1]).toMatchObject({ status: "unavailable" });
    expect(limited[1]).toMatchObject({ status: "rate-limited" });
  });

  it("replaces the failed answer on retry without touching the question", () => {
    const failed = chatReducer(sent([], 1), { type: "failed", id: "a1", status: "error" });
    const retried = chatReducer(failed, { type: "retried", id: "a1", newId: "a2" });

    expect(retried).toEqual([
      { id: "u1", role: "user", content: "q1" },
      { id: "a2", role: "expert", content: "", status: "streaming" },
    ]);
  });
});

describe("buildHistory", () => {
  it("maps the expert to assistant and leaves out failed or empty answers", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "q1" },
      { id: "a1", role: "expert", content: "r1", status: "done" },
      { id: "u2", role: "user", content: "q2" },
      { id: "a2", role: "expert", content: "", status: "error" },
      { id: "u3", role: "user", content: "q3" },
      { id: "a3", role: "expert", content: "parcial", status: "incomplete" },
      { id: "u4", role: "user", content: "q4" },
      { id: "a4", role: "expert", content: "", status: "streaming" },
    ];

    expect(buildHistory(messages)).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "r1" },
      { role: "user", content: "q2" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "parcial" },
      { role: "user", content: "q4" },
    ]);
  });

  it("keeps only the last 20 turns", () => {
    const messages: ChatMessage[] = Array.from({ length: 30 }, (_, index) => ({
      id: `u${index}`,
      role: "user" as const,
      content: `q${index}`,
    }));
    const history = buildHistory(messages);

    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0]?.content).toBe("q10");
    expect(history.at(-1)?.content).toBe("q29");
  });

  it("cuts a long text to the limit of the API", () => {
    const history = buildHistory([
      { id: "a1", role: "expert", content: "x".repeat(MESSAGE_LIMIT + 50), status: "done" },
    ]);

    expect(history[0]?.content).toHaveLength(MESSAGE_LIMIT);
  });
});
