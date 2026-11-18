import { describe, expect, it } from "vitest";
import { readServerSentEvents, type SseMessage } from "./sse";

function streamOf(...chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }

      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseMessage[]> {
  const messages: SseMessage[] = [];

  for await (const message of readServerSentEvents(body)) {
    messages.push(message);
  }

  return messages;
}

describe("readServerSentEvents", () => {
  it("yields one message per event, with the event name and the JSON data", async () => {
    const messages = await collect(
      streamOf('event: delta\ndata: {"text":"Oi"}\n\nevent: done\ndata: {}\n\n'),
    );

    expect(messages).toEqual([
      { event: "delta", data: { text: "Oi" } },
      { event: "done", data: {} },
    ]);
  });

  it("joins events split anywhere in the chunks", async () => {
    const messages = await collect(
      streamOf("event: del", 'ta\ndata: {"te', 'xt":"a"}\n', "\nevent: done\ndata: {}\n\n"),
    );

    expect(messages.map((message) => message.event)).toEqual(["delta", "done"]);
    expect(messages[0]?.data).toEqual({ text: "a" });
  });

  it("decodes a multi-byte character cut between two chunks", async () => {
    const bytes = new TextEncoder().encode('event: delta\ndata: {"text":"ação"}\n\n');
    const cut = bytes.indexOf(0xc3) + 1;
    const messages = await collect(streamOf(bytes.slice(0, cut), bytes.slice(cut)));

    expect(messages).toEqual([{ event: "delta", data: { text: "ação" } }]);
  });

  it("accepts CRLF line endings and a data line without the space", async () => {
    const messages = await collect(streamOf('event: delta\r\ndata:{"text":"x"}\r\n\r\n'));

    expect(messages).toEqual([{ event: "delta", data: { text: "x" } }]);
  });

  it("names an event without `event:` as message and ignores comments", async () => {
    const messages = await collect(streamOf(': keep-alive\n\ndata: {"a":1}\n\n'));

    expect(messages).toEqual([{ event: "message", data: { a: 1 } }]);
  });

  it("drops a block that is not JSON and keeps reading", async () => {
    const messages = await collect(
      streamOf("event: delta\ndata: not json\n\nevent: done\ndata: {}\n\n"),
    );

    expect(messages).toEqual([{ event: "done", data: {} }]);
  });

  it("yields the last event even when the stream ends without the blank line", async () => {
    const messages = await collect(streamOf("event: done\ndata: {}"));

    expect(messages).toEqual([{ event: "done", data: {} }]);
  });

  it("releases the stream when the consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"x"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const _message of readServerSentEvents(body)) {
      break;
    }

    expect(cancelled).toBe(true);
  });
});
