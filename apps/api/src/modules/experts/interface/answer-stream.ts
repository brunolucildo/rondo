import type { ExpertAnswerEvent } from "../domain/expert-ports";
import type { ExpertMessageResult } from "../../../observability/expert-telemetry";

/** The slice of the HTTP response the stream needs; keeps this file free of Express types. */
export interface StreamResponse {
  statusCode: number;
  readonly writableEnded: boolean;
  setHeader(name: string, value: string): unknown;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
}

export const ANSWER_FAILED_MESSAGE = "The expert couldn't answer.";
export const KNOWLEDGE_UNAVAILABLE_MESSAGE = "We couldn't search your sources right now.";

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Writes the answer as Server-Sent Events: `delta` (`{ text }`) for each piece, then `citations`
 * (`{ citations }`, only when the retrieval ran; an empty list means no source covers the
 * question) and `done`, or `error` (`{ code, message }`) when the model failed
 * (`EXPERT_ANSWER_FAILED`) or the sources could not be searched (`KNOWLEDGE_UNAVAILABLE`). A client that left (Stop, closed tab)
 * gets nothing more. Returns what happened, for the telemetry; the text itself is never kept.
 */
export async function writeAnswerStream(
  response: StreamResponse,
  events: AsyncIterable<ExpertAnswerEvent>,
): Promise<ExpertMessageResult> {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  // Tells proxies such as nginx not to hold the stream back.
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();

  let result: ExpertMessageResult = {
    outcome: "aborted",
    reason: "aborted",
    inputTokens: null,
    outputTokens: null,
  };

  for await (const event of events) {
    switch (event.type) {
      case "text":
        response.write(frame("delta", { text: event.text }));
        break;
      case "citations":
        response.write(frame("citations", { citations: event.citations }));
        break;
      case "done":
        response.write(frame("done", {}));
        result = {
          outcome: "success",
          reason: "none",
          inputTokens: event.usage?.inputTokens ?? null,
          outputTokens: event.usage?.outputTokens ?? null,
        };
        break;
      case "failed":
        response.write(
          event.reason === "knowledge_unavailable"
            ? frame("error", {
                code: "KNOWLEDGE_UNAVAILABLE",
                message: KNOWLEDGE_UNAVAILABLE_MESSAGE,
              })
            : frame("error", { code: "EXPERT_ANSWER_FAILED", message: ANSWER_FAILED_MESSAGE }),
        );
        result = {
          outcome: "failure",
          reason: event.reason,
          inputTokens: null,
          outputTokens: null,
        };
        break;
      case "aborted":
        break;
    }
  }

  if (!response.writableEnded) {
    response.end();
  }

  return result;
}
