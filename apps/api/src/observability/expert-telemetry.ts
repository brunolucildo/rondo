import { SpanStatusCode, trace } from "@opentelemetry/api";
import { baseLogger } from "./logger";

const TRACER_NAME = "rondo-api";

export type ExpertMessageOutcome = "success" | "failure" | "aborted";

/** Closed set: the reason of a failure or an abort, never text from the client or the provider. */
export type ExpertMessageReason = "none" | "provider_error" | "timeout" | "aborted" | "unavailable";

export interface ExpertMessageResult {
  outcome: ExpertMessageOutcome;
  reason: ExpertMessageReason;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ExpertMessageContext {
  /** One of the catalog ids (a closed set), never a value read from the request. */
  expertId: string;
  requestId?: string;
}

/** Writes the `expert_message` log. Only ids, outcome, duration and token counts: never content. */
export function logExpertMessage(
  context: ExpertMessageContext,
  result: ExpertMessageResult,
  durationMs: number,
): void {
  const fields = {
    event: "expert_message",
    expertId: context.expertId,
    outcome: result.outcome,
    reason: result.reason,
    durationMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    requestId: context.requestId,
  };

  if (result.outcome === "failure") {
    baseLogger.warn(fields, "expert_message");
    return;
  }

  baseLogger.info(fields, "expert_message");
}

/**
 * Runs one answer inside the span `expert.message` (a child of the HTTP span) and writes the
 * `expert_message` log when it ends. The span carries the expert id, the outcome and token counts;
 * no message, prompt, history or provider text goes to the span or the log.
 */
export async function traceExpertMessage(
  context: ExpertMessageContext,
  run: () => Promise<ExpertMessageResult>,
): Promise<ExpertMessageResult> {
  const startedAt = performance.now();

  return trace
    .getTracer(TRACER_NAME)
    .startActiveSpan(
      "expert.message",
      { attributes: { "expert.id": context.expertId } },
      async (span) => {
        const result = await run().catch((): ExpertMessageResult => ({
          outcome: "failure",
          reason: "provider_error",
          inputTokens: null,
          outputTokens: null,
        }));

        span.setAttribute("expert.outcome", result.outcome);
        span.setAttribute("expert.reason", result.reason);

        if (result.inputTokens !== null && result.outputTokens !== null) {
          span.setAttribute("expert.tokens.input", result.inputTokens);
          span.setAttribute("expert.tokens.output", result.outputTokens);
        }

        if (result.outcome === "failure") {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }

        span.end();
        logExpertMessage(context, result, Math.round(performance.now() - startedAt));

        return result;
      },
    );
}
