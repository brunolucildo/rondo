import { Readable } from "node:stream";
import type { Response } from "supertest";

export interface SseEvent {
  event: string;
  data: unknown;
}

/** Parses a complete Server-Sent Events body into its events. */
export function parseSse(body: string): SseEvent[] {
  return body
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
      const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length);

      return { event: event ?? "message", data: data === undefined ? null : JSON.parse(data) };
    });
}

/** The text of every `delta` event, joined: what the user sees. */
export function answerText(events: readonly SseEvent[]): string {
  return events
    .filter((event) => event.event === "delta")
    .map((event) => (event.data as { text: string }).text)
    .join("");
}

/**
 * Supertest parser that keeps an event stream as a string (`response.body`), so a test can read
 * the whole answer once the server ends it.
 */
export function readText(
  response: Response,
  callback: (error: Error | null, body: string) => void,
): void {
  // At runtime supertest hands over the raw `IncomingMessage`; its `Response` type hides that.
  if (!(response instanceof Readable)) {
    callback(new Error("Expected a readable response stream"), "");

    return;
  }

  let data = "";

  response.setEncoding("utf8");
  response.on("data", (chunk: string) => {
    data += chunk;
  });
  response.on("end", () => callback(null, data));
  response.on("error", (error) => callback(error, data));
}
