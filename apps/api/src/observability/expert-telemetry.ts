import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { DURATION_BUCKETS_SECONDS } from "./duration-buckets";
import { type KnowledgeFailureReason } from "./knowledge-telemetry";
import { baseLogger } from "./logger";

const TRACER_NAME = "rondo-api";

export type ExpertMessageOutcome = "success" | "failure" | "aborted";

/** Closed set: the reason of a failure or an abort, never text from the client or the provider. */
export type ExpertMessageReason =
  | "none"
  | "provider_error"
  | "timeout"
  | "aborted"
  | "unavailable"
  | "storage_error"
  | "knowledge_unavailable";

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

/**
 * Telemetry of the retrieval of an answer (spec `0024`). Content-free by construction: every
 * label, attribute and log field is from a closed set or is a number. Never the question, a chunk,
 * a source name, a `userId` or a `connectionId`.
 */
export type ExpertRetrievalOutcome = "found" | "gap" | "failure";
export type ExpertRetrievalScope = "all" | "connections";
/** Closed set for the reason of a failed retrieval (the knowledge failure reasons). */
export type ExpertRetrievalReason = "none" | KnowledgeFailureReason;

export interface ExpertRetrievalRecord {
  outcome: ExpertRetrievalOutcome;
  /** `all`: the whole base of the user; `connections`: limited to the attached files. */
  scope: ExpertRetrievalScope;
  reason: ExpertRetrievalReason;
  /** Chunks that passed the threshold (and went to the model). */
  chunks: number;
  durationSeconds: number;
}

function createRetrievalInstruments() {
  const meter = metrics.getMeter(TRACER_NAME);

  return {
    retrievals: meter.createCounter("expert.retrievals", {
      description: "Retrievals of knowledge for an answer of an expert, by outcome and scope.",
      unit: "{retrieval}",
    }),
    duration: meter.createHistogram("expert.retrieval.duration", {
      description: "Time to embed the question and search the index, by outcome and scope.",
      unit: "s",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS },
    }),
    chunks: meter.createHistogram("expert.retrieval.chunks", {
      description: "Chunks that passed the similarity threshold for one question.",
      unit: "{chunk}",
      advice: { explicitBucketBoundaries: [0, 1, 2, 3, 4, 5, 6, 8, 12] },
    }),
  };
}

let retrievalInstruments: ReturnType<typeof createRetrievalInstruments> | undefined;

// Created on first use: the API meter provider is only registered when the SDK starts.
function getRetrievalInstruments() {
  retrievalInstruments ??= createRetrievalInstruments();

  return retrievalInstruments;
}

/** Counter, histograms and the `expert_retrieval` log of one retrieval. Never throws. */
export function recordExpertRetrieval(record: ExpertRetrievalRecord): void {
  try {
    const { retrievals, duration, chunks } = getRetrievalInstruments();
    const attributes = { outcome: record.outcome, scope: record.scope };

    retrievals.add(1, attributes);
    duration.record(record.durationSeconds, attributes);
    chunks.record(record.chunks, attributes);

    const fields = {
      event: "expert_retrieval",
      outcome: record.outcome,
      scope: record.scope,
      reason: record.reason,
      chunks: record.chunks,
      durationMs: Math.round(record.durationSeconds * 1000),
    };

    if (record.outcome === "failure") {
      baseLogger.warn(fields, "expert_retrieval");
    } else {
      baseLogger.info(fields, "expert_retrieval");
    }
  } catch {
    // Telemetry must never change the answer.
  }
}

/**
 * Runs the retrieval inside the span `expert.retrieval` (a child of the answer span) and records
 * it when it ends. `run` returns what to record; the span carries the outcome, the scope and the
 * chunk count only. A thrown error is recorded as a failure and rethrown untouched.
 */
export async function traceExpertRetrieval<T>(
  scope: ExpertRetrievalScope,
  run: () => Promise<{ value: T; outcome: ExpertRetrievalOutcome; chunks: number }>,
  reasonOf: (error: unknown) => ExpertRetrievalReason,
): Promise<T> {
  const startedAt = performance.now();

  return trace
    .getTracer(TRACER_NAME)
    .startActiveSpan(
      "expert.retrieval",
      { attributes: { "expert.retrieval.scope": scope } },
      async (span) => {
        try {
          const { value, outcome, chunks } = await run();

          span.setAttribute("expert.retrieval.outcome", outcome);
          span.setAttribute("expert.retrieval.chunks", chunks);
          recordExpertRetrieval({
            outcome,
            scope,
            reason: "none",
            chunks,
            durationSeconds: (performance.now() - startedAt) / 1000,
          });

          return value;
        } catch (error) {
          const reason = reasonOf(error);

          span.setAttribute("expert.retrieval.outcome", "failure");
          span.setAttribute("expert.retrieval.reason", reason);
          span.setStatus({ code: SpanStatusCode.ERROR });
          recordExpertRetrieval({
            outcome: "failure",
            scope,
            reason,
            chunks: 0,
            durationSeconds: (performance.now() - startedAt) / 1000,
          });

          throw error;
        } finally {
          span.end();
        }
      },
    );
}
