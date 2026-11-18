import { describe, expect, it } from "vitest";
import type { ExpertAnswerEvent } from "../domain/expert-ports";
import {
  ANSWER_FAILED_MESSAGE,
  KNOWLEDGE_UNAVAILABLE_MESSAGE,
  type StreamResponse,
  writeAnswerStream,
} from "./answer-stream";

function fakeResponse() {
  const written: string[] = [];
  const headers: Record<string, string> = {};
  const response: StreamResponse & { writableEnded: boolean } = {
    statusCode: 0,
    writableEnded: false,
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    flushHeaders: () => {
      written.push("<headers flushed>");
    },
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    end: () => {
      response.writableEnded = true;
    },
  };

  return { response, written, headers };
}

async function* events(...list: ExpertAnswerEvent[]) {
  for (const event of list) {
    yield event;
  }
}

describe("writeAnswerStream (R5, R8)", () => {
  it("flushes the SSE headers first, then one delta per piece and a done event", async () => {
    const { response, written, headers } = fakeResponse();
    const result = await writeAnswerStream(
      response,
      events(
        { type: "text", text: "Olá " },
        { type: "text", text: "mundo\nlinha" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
      ),
    );

    expect(response.statusCode).toBe(200);
    expect(headers["Content-Type"]).toBe("text/event-stream; charset=utf-8");
    expect(headers["Cache-Control"]).toContain("no-cache");
    expect(written).toEqual([
      "<headers flushed>",
      'event: delta\ndata: {"text":"Olá "}\n\n',
      'event: delta\ndata: {"text":"mundo\\nlinha"}\n\n',
      "event: done\ndata: {}\n\n",
    ]);
    expect(response.writableEnded).toBe(true);
    expect(result).toEqual({
      outcome: "success",
      reason: "none",
      inputTokens: 5,
      outputTokens: 2,
    });
  });

  it("writes a typed error event, without the provider's detail, when the model failed", async () => {
    const { response, written } = fakeResponse();
    const result = await writeAnswerStream(
      response,
      events({ type: "text", text: "par" }, { type: "failed", reason: "provider_error" }),
    );

    expect(written.at(-1)).toBe(
      `event: error\ndata: ${JSON.stringify({ code: "EXPERT_ANSWER_FAILED", message: ANSWER_FAILED_MESSAGE })}\n\n`,
    );
    expect(result).toMatchObject({ outcome: "failure", reason: "provider_error" });
    expect(response.writableEnded).toBe(true);
  });

  it("writes the citations event right before done, with the sources and nothing else", async () => {
    const { response, written } = fakeResponse();
    const citation = { connectionId: "c1", sourceName: "plano.pdf", page: 2, position: 3 };

    await writeAnswerStream(
      response,
      events(
        { type: "text", text: "Resposta" },
        { type: "citations", citations: [citation] },
        { type: "done", usage: null },
      ),
    );

    expect(written).toEqual([
      "<headers flushed>",
      'event: delta\ndata: {"text":"Resposta"}\n\n',
      `event: citations\ndata: ${JSON.stringify({ citations: [citation] })}\n\n`,
      "event: done\ndata: {}\n\n",
    ]);
  });

  it("writes an empty citations list for the gap", async () => {
    const { response, written } = fakeResponse();

    await writeAnswerStream(
      response,
      events({ type: "citations", citations: [] }, { type: "done", usage: null }),
    );

    expect(written).toContain('event: citations\ndata: {"citations":[]}\n\n');
  });

  it("writes KNOWLEDGE_UNAVAILABLE when the sources could not be searched", async () => {
    const { response, written } = fakeResponse();
    const result = await writeAnswerStream(
      response,
      events({ type: "failed", reason: "knowledge_unavailable" }),
    );

    expect(written.at(-1)).toBe(
      `event: error\ndata: ${JSON.stringify({ code: "KNOWLEDGE_UNAVAILABLE", message: KNOWLEDGE_UNAVAILABLE_MESSAGE })}\n\n`,
    );
    expect(result).toMatchObject({ outcome: "failure", reason: "knowledge_unavailable" });
  });

  it("reports a timeout failure", async () => {
    const { response } = fakeResponse();

    expect(
      await writeAnswerStream(response, events({ type: "failed", reason: "timeout" })),
    ).toMatchObject({ outcome: "failure", reason: "timeout" });
  });

  it("writes nothing more after an abort and reports it", async () => {
    const { response, written } = fakeResponse();
    const result = await writeAnswerStream(
      response,
      events({ type: "text", text: "a" }, { type: "aborted" }),
    );

    expect(written).toHaveLength(2);
    expect(result).toEqual({
      outcome: "aborted",
      reason: "aborted",
      inputTokens: null,
      outputTokens: null,
    });
    expect(response.writableEnded).toBe(true);
  });

  it("reports unknown token usage as null", async () => {
    const { response } = fakeResponse();

    expect(await writeAnswerStream(response, events({ type: "done", usage: null }))).toMatchObject({
      inputTokens: null,
      outputTokens: null,
    });
  });
});
