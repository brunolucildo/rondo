import { describe, expect, it } from "vitest";
import {
  type ChatMessage,
  chatReducer,
  type Citation,
  fromStoredMessages,
  type StoredMessage,
} from "./chat-state";

const sent = (messages: ChatMessage[], n: number): ChatMessage[] =>
  chatReducer(messages, { type: "sent", userId: `u${n}`, expertId: `a${n}`, content: `q${n}` });

describe("chatReducer", () => {
  it("appends the question and an empty streaming answer", () => {
    expect(sent([], 1)).toEqual([
      { id: "u1", role: "user", content: "q1" },
      { id: "a1", role: "expert", content: "", status: "streaming", citations: null },
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
      { id: "a2", role: "expert", content: "", status: "streaming", citations: null },
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
      { id: "2", role: "expert", content: "r1", status: "done", citations: null },
      { id: "3", role: "user", content: "q2" },
      { id: "4", role: "expert", content: "parc", status: "incomplete", citations: null },
    ]);
  });

  it("is empty for no messages", () => {
    expect(fromStoredMessages([])).toEqual([]);
  });

  it("keeps the stored citations: a list, an empty list (the gap) or none", () => {
    const citation = { connectionId: "c1", sourceName: "plano.pdf", page: 2, position: 3 };
    const stored = (id: string, citations: Citation[] | null | undefined): StoredMessage => ({
      id,
      role: "assistant",
      content: "r",
      status: "complete",
      ...(citations === undefined ? {} : { citations }),
      createdAt: "2026-11-17T12:00:00.000Z",
    });

    expect(
      fromStoredMessages([
        stored("1", [citation]),
        stored("2", []),
        stored("3", null),
        stored("4", undefined),
      ]).map((message) => (message.role === "expert" ? message.citations : "user")),
    ).toEqual([[citation], [], null, null]);
  });
});

describe("chatReducer: sources and refused files (R9)", () => {
  const citation = { connectionId: "c1", sourceName: "plano.pdf", page: null, position: 0 };

  it("sets the citations of the answer", () => {
    const messages = chatReducer(sent([], 1), {
      type: "citations",
      id: "a1",
      citations: [citation],
    });

    expect(messages[1]).toMatchObject({ citations: [citation], status: "streaming" });
  });

  it("keeps the citations when the answer is finished", () => {
    let messages = chatReducer(sent([], 1), { type: "citations", id: "a1", citations: [] });

    messages = chatReducer(messages, { type: "finished", id: "a1" });

    expect(messages[1]).toMatchObject({ citations: [], status: "done" });
  });

  it("drops the question and its answer when the server refused the attached files", () => {
    const messages = sent(sent([], 1), 2);

    expect(chatReducer(messages, { type: "unsent", id: "a2" })).toEqual(sent([], 1));
  });

  it("keeps the knowledge-unavailable status as it is, with or without text", () => {
    const failed = chatReducer(sent([], 1), {
      type: "failed",
      id: "a1",
      status: "knowledge-unavailable",
    });

    expect(failed[1]).toMatchObject({ status: "knowledge-unavailable", content: "" });
  });
});
