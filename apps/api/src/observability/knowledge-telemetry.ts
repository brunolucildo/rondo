import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { DURATION_BUCKETS_SECONDS } from "./duration-buckets";
import { baseLogger } from "./logger";

/**
 * Telemetry of the knowledge module (spec `0022`): the vector index and the embeddings provider.
 *
 * Content-free by construction. Every label, attribute and log field below comes from a closed
 * set or is a number: never chunk text, a vector, a tenant name, a `userId`, a `connectionId`, a
 * file name or an error message.
 */

/** Every index operation that has telemetry (the `operation` label and span suffix). */
export const KNOWLEDGE_INDEX_OPERATIONS = [
  "upsert",
  "search",
  "delete_by_connection",
  "delete_all_for_user",
] as const;

export type KnowledgeIndexOperation = (typeof KNOWLEDGE_INDEX_OPERATIONS)[number];
export type KnowledgeOutcome = "success" | "failure";

/** Closed set for the `reason` of a failed call; anything else collapses into `unknown`. */
export const KNOWLEDGE_FAILURE_REASONS = [
  "connection",
  "timeout",
  "unauthorized",
  "server_error",
  "rejected",
  "not_configured",
  "rate_limited",
  "provider_error",
  "invalid_input",
  "unknown",
] as const;

export type KnowledgeFailureReason = (typeof KNOWLEDGE_FAILURE_REASONS)[number];

const KNOWN_REASONS: ReadonlySet<string> = new Set(KNOWLEDGE_FAILURE_REASONS);

export function failureReasonOf(code: string | undefined): KnowledgeFailureReason {
  const reason = code?.toLowerCase() ?? "unknown";

  return KNOWN_REASONS.has(reason) ? (reason as KnowledgeFailureReason) : "unknown";
}

const METER_NAME = "rondo-api";

function createInstruments() {
  const meter = metrics.getMeter(METER_NAME);

  return {
    indexDuration: meter.createHistogram("knowledge.index.operation.duration", {
      description: "Time the vector index took to answer an operation, as seen by the API.",
      unit: "s",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS },
    }),
    embeddingsDuration: meter.createHistogram("knowledge.embeddings.duration", {
      description: "Time the embeddings provider took to answer one request (retries included).",
      unit: "s",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS },
    }),
    embeddingsTexts: meter.createCounter("knowledge.embeddings.texts", {
      description: "Texts sent to the embeddings provider, by outcome.",
      unit: "{text}",
    }),
  };
}

let instruments: ReturnType<typeof createInstruments> | undefined;

// Created on first use: the API meter provider is only registered when the SDK starts.
function getInstruments() {
  instruments ??= createInstruments();

  return instruments;
}

export interface KnowledgeIndexCall {
  operation: KnowledgeIndexOperation;
  outcome: KnowledgeOutcome;
  reason: KnowledgeFailureReason | "none";
  durationSeconds: number;
}

export interface EmbeddingsCall {
  outcome: KnowledgeOutcome;
  reason: KnowledgeFailureReason | "none";
  texts: number;
  durationSeconds: number;
}

/** Records one index operation: a duration point and one log line, both content-free. */
export function recordKnowledgeIndexCall(call: KnowledgeIndexCall): void {
  try {
    getInstruments().indexDuration.record(call.durationSeconds, {
      operation: call.operation,
      outcome: call.outcome,
    });

    const fields = {
      event: "knowledge_index_operation",
      operation: call.operation,
      outcome: call.outcome,
      reason: call.reason,
      durationMs: Math.round(call.durationSeconds * 1000),
    };

    if (call.outcome === "success") {
      baseLogger.info(fields, "knowledge_index_operation");
    } else {
      baseLogger.warn(fields, "knowledge_index_operation");
    }
  } catch {
    // Telemetry must never change the answer.
  }
}

/** Records one embeddings request: a duration point, the text count and one log line. */
export function recordEmbeddingsCall(call: EmbeddingsCall): void {
  try {
    const { embeddingsDuration, embeddingsTexts } = getInstruments();

    embeddingsDuration.record(call.durationSeconds, { outcome: call.outcome });
    embeddingsTexts.add(call.texts, { outcome: call.outcome });

    const fields = {
      event: "knowledge_embeddings_request",
      outcome: call.outcome,
      reason: call.reason,
      texts: call.texts,
      durationMs: Math.round(call.durationSeconds * 1000),
    };

    if (call.outcome === "success") {
      baseLogger.info(fields, "knowledge_embeddings_request");
    } else {
      baseLogger.warn(fields, "knowledge_embeddings_request");
    }
  } catch {
    // Telemetry must never change the answer.
  }
}

/**
 * Runs one operation inside the span `<name>`, a child of whatever is active. The span carries the
 * operation and the outcome only; on failure it gets status `ERROR` and the closed `reason`, never
 * the exception message, stack or event. The error is rethrown untouched.
 */
export async function traceKnowledge<T>(
  name: string,
  attributes: Record<string, string>,
  run: () => Promise<T>,
  reasonOf: (error: unknown) => KnowledgeFailureReason,
): Promise<T> {
  return trace.getTracer(METER_NAME).startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await run();

      span.setAttribute("knowledge.outcome", "success");

      return result;
    } catch (error) {
      span.setAttribute("knowledge.outcome", "failure");
      span.setAttribute("knowledge.error_reason", reasonOf(error));
      span.setStatus({ code: SpanStatusCode.ERROR });

      throw error;
    } finally {
      span.end();
    }
  });
}
