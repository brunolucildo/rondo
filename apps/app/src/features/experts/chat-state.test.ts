import { describe, expect, it } from "vitest";
import { type ChatMessage, chatReducer, fromStoredMessages } from "./chat-state";

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

describe("chatReducer: clear and busy", () => {
  it("empties the conversation when it is cleared", () => {
    expect(chatReducer(sent([], 1), { type: "cleared" })).toEqual([]);
  });

  it("keeps the busy status of a refused send", () => {
    expect(chatReducer(sent([], 1), { type: "failed", id: "a1", status: "busy" })[1]).toMatchObject(
      {
        status: "busy",
        content: "",
      },
    );
  });
});

describe("fromStoredMessages (R9)", () => {
  it("keeps the order, maps assistant to the expert and marks incomplete answers", () => {
    expect(
      fromStoredMessages([
        {
          id: "1",
          role: "user",
          content: "q1",
          status: "complete",
          createdAt: "2026-11-17T12:00:00.000Z",
        },
        {
          id: "2",
          role: "assistant",
          content: "r1",
          status: "complete",
          createdAt: "2026-11-17T12:00:01.000Z",
        },
        {
          id: "3",
          role: "user",
          content: "q2",
          status: "complete",
          createdAt: "2026-11-17T12:00:02.000Z",
        },
        {
          id: "4",
          role: "assistant",
          content: "parc",
          status: "incomplete",
          createdAt: "2026-11-17T12:00:03.000Z",
        },
      ]),
    ).toEqual<ChatMessage[]>([
      { id: "1", role: "user", content: "q1" },
      { id: "2", role: "expert", content: "r1", status: "done" },
      { id: "3", role: "user", content: "q2" },
      { id: "4", role: "expert", content: "parc", status: "incomplete" },
    ]);
  });

  it("is empty for no messages", () => {
    expect(fromStoredMessages([])).toEqual([]);
  });
});
