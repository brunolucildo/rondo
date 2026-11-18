import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { activeTraceFields } from "./agent-telemetry";
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
  /** `performance.now()` when the request arrived: the clock of the duration and the first token. */
  startedAt?: number;
}

/**
 * The seven catalog ids (`modules/experts/domain/expert-catalog.ts`; a unit test keeps both lists
 * equal). Anything else is `unknown`, so a metric label never takes a value the client controls.
 */
export const EXPERT_LABELS = [
  "head-coach",
  "performance-analyst",
  "sports-lawyer",
  "physiologist",
  "sports-physician",
  "physiotherapist",
  "football-manager",
] as const;

const KNOWN_EXPERTS: ReadonlySet<string> = new Set(EXPERT_LABELS);

export function expertLabelOf(expertId: string): string {
  return KNOWN_EXPERTS.has(expertId) ? expertId : "unknown";
}

/** Answers last seconds, not milliseconds: the buckets reach the 120 s total timeout. */
const ANSWER_DURATION_BUCKETS_SECONDS = [
  0.1, 0.25, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 45, 60, 90, 120,
];

function createMessageInstruments() {
  const meter = metrics.getMeter(TRACER_NAME);

  return {
    duration: meter.createHistogram("expert.message.duration", {
      description: "Time from the request to the end of the answer of an expert, by outcome.",
      unit: "s",
      advice: { explicitBucketBoundaries: ANSWER_DURATION_BUCKETS_SECONDS },
    }),
    firstToken: meter.createHistogram("expert.first_token", {
      description: "Time from the request to the first token sent to the client.",
      unit: "s",
      advice: { explicitBucketBoundaries: ANSWER_DURATION_BUCKETS_SECONDS },
    }),
    tokens: meter.createCounter("expert.llm.tokens", {
      description: "Tokens the provider reported for the answers, by direction.",
      unit: "{token}",
    }),
    grounded: meter.createCounter("expert.grounded", {
      description: "Answers by grounding: from a source, no source covers it, or no retrieval.",
      unit: "{answer}",
    }),
  };
}

let messageInstruments: ReturnType<typeof createMessageInstruments> | undefined;

// Created on first use: the API meter provider is only registered when the SDK starts.
function getMessageInstruments() {
  messageInstruments ??= createMessageInstruments();

  return messageInstruments;
}

export type ExpertGrounded = "yes" | "gap" | "skipped";

/** Counts one answer by grounding (`yes`: from a source; `gap`: no source covers it; `skipped`: no retrieval). */
export function recordExpertGrounded(grounded: ExpertGrounded): void {
  try {
    getMessageInstruments().grounded.add(1, { grounded });
  } catch {
    // Telemetry must never change the answer.
  }
}

/** Writes the `expert_message` log. Only ids, outcome, duration and token counts: never content. */
export function logExpertMessage(
  context: ExpertMessageContext,
  result: ExpertMessageResult,
  durationMs: number,
): void {
  const fields = {
    event: "expert_message",
    expertId: expertLabelOf(context.expertId),
    outcome: result.outcome,
    reason: result.reason,
    durationMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    requestId: context.requestId,
    ...activeTraceFields(),
  };

  if (result.outcome === "failure") {
    baseLogger.warn(fields, "expert_message");
    return;
  }

  baseLogger.info(fields, "expert_message");
}

/**
 * The metrics and the log of one answer, once it ended: duration by outcome, the tokens the
 * provider reported (never an estimate: without them an `expert_usage_unavailable` log says so),
 * and the `expert_message` log. Never throws.
 */
export function recordExpertMessage(
  context: ExpertMessageContext,
  result: ExpertMessageResult,
  durationMs: number,
): void {
  try {
    const { duration, tokens } = getMessageInstruments();
    const expert = expertLabelOf(context.expertId);

    duration.record(durationMs / 1000, { expert, outcome: result.outcome });

    if (result.inputTokens !== null && result.outputTokens !== null) {
      tokens.add(result.inputTokens, { expert, direction: "input" });
      tokens.add(result.outputTokens, { expert, direction: "output" });
    } else if (result.outcome === "success") {
      baseLogger.warn(
        { event: "expert_usage_unavailable", expertId: expert, ...activeTraceFields() },
        "expert_usage_unavailable",
      );
    }

    logExpertMessage(context, result, durationMs);
  } catch {
    // Telemetry must never change the answer.
  }
}

/** What the writer of the answer tells the telemetry while the answer streams. */
export interface ExpertMessageProbe {
  /** The first token went to the client. Only the first call counts. */
  firstToken(): void;
}

/**
 * Runs one answer inside the span `expert.message` (a child of the HTTP span) and records it when
 * it ends. The span carries the expert id, the outcome, the closed `expert.error_code` (only on
 * failure) and token counts; no message, prompt, history or provider text goes to the span, a
 * metric or the log. `aborted` (the user pressed Stop) is not an error.
 */
export async function traceExpertMessage(
  context: ExpertMessageContext,
  run: (probe: ExpertMessageProbe) => Promise<ExpertMessageResult>,
): Promise<ExpertMessageResult> {
  const startedAt = context.startedAt ?? performance.now();
  let firstTokenSeen = false;
  const probe: ExpertMessageProbe = {
    firstToken() {
      if (firstTokenSeen) {
        return;
      }

      firstTokenSeen = true;

      try {
        getMessageInstruments().firstToken.record((performance.now() - startedAt) / 1000, {
          expert: expertLabelOf(context.expertId),
        });
      } catch {
        // Telemetry must never change the answer.
      }
    },
  };

  return trace
    .getTracer(TRACER_NAME)
    .startActiveSpan(
      "expert.message",
      { attributes: { "expert.id": expertLabelOf(context.expertId) } },
      async (span) => {
        const result = await run(probe).catch((): ExpertMessageResult => ({
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
          span.setAttribute("expert.error_code", result.reason);
          span.setStatus({ code: SpanStatusCode.ERROR });
        }

        span.end();
        // Ended, but still the active span: the log gets its `trace_id` and `span_id`.
        recordExpertMessage(context, result, Math.round(performance.now() - startedAt));

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

const CHUNK_BUCKETS = [0, 1, 2, 3, 4, 5, 6, 8, 12];

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
      advice: { explicitBucketBoundaries: CHUNK_BUCKETS },
    }),
    // Spec 0029 (R3): the same count under the closed contract of the agent dashboard, whose
    // scope is `all` or `attached` and which only counts retrievals that ran to the end.
    hits: meter.createHistogram("expert.retrieval.hits", {
      description: "Chunks recovered for one question, by scope (all the base or attached files).",
      unit: "{chunk}",
      advice: { explicitBucketBoundaries: CHUNK_BUCKETS },
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
    const { retrievals, duration, chunks, hits } = getRetrievalInstruments();
    const attributes = { outcome: record.outcome, scope: record.scope };

    retrievals.add(1, attributes);
    duration.record(record.durationSeconds, attributes);
    chunks.record(record.chunks, attributes);

    if (record.outcome !== "failure") {
      hits.record(record.chunks, {
        scope: record.scope === "connections" ? "attached" : record.scope,
      });
    }

    const fields = {
      event: "expert_retrieval",
      outcome: record.outcome,
      scope: record.scope,
      reason: record.reason,
      chunks: record.chunks,
      durationMs: Math.round(record.durationSeconds * 1000),
      ...activeTraceFields(),
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
