import { metrics, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { baseLogger } from "./logger";
import { failureReasonOf, type KnowledgeFailureReason } from "./knowledge-telemetry";

/**
 * Telemetry of the agent as a whole (spec `0029`): the nodes of the LangGraph graph, the call to
 * the chat model and the calls to the external dependencies, on top of the signals each slice
 * already has.
 *
 * Content-free by construction. Every span attribute, metric label and log field below comes from
 * a closed set or is a number: never a question, an answer, a prompt, a chunk, a source name, a
 * `userId`, a `connectionId`, a URL, a key or the message of a provider error.
 */

const TRACER_NAME = "rondo-api";

/** The external services an answer or an ingestion depends on (the `dependency` label). */
export const EXPERT_DEPENDENCIES = ["openai", "weaviate", "gemini"] as const;

export type ExpertDependency = (typeof EXPERT_DEPENDENCIES)[number];
export type DependencyOutcome = "success" | "failure";

/** `trace_id` and `span_id` of the active span, so a log line opens its trace (and back). */
export function activeTraceFields(): { trace_id?: string; span_id?: string } {
  const context = trace.getActiveSpan()?.spanContext();

  return context === undefined ? {} : { trace_id: context.traceId, span_id: context.spanId };
}

function createInstruments() {
  const meter = metrics.getMeter(TRACER_NAME);

  return {
    dependencyCalls: meter.createCounter("expert.dependency.calls", {
      description:
        "Calls to the external dependencies of the agents (OpenAI, Weaviate, Gemini), by outcome.",
      unit: "{call}",
    }),
  };
}

let instruments: ReturnType<typeof createInstruments> | undefined;

// Created on first use: the API meter provider is only registered when the SDK starts.
function getInstruments() {
  instruments ??= createInstruments();

  return instruments;
}

/**
 * Counts one call to a dependency and, on failure, writes `expert_dependency_failed` (a rare event,
 * so the alerts count the log, not the counter). Never throws.
 */
export function recordDependencyCall(
  dependency: ExpertDependency,
  outcome: DependencyOutcome,
  reason: KnowledgeFailureReason | "none",
  durationSeconds: number,
): void {
  try {
    getInstruments().dependencyCalls.add(1, { dependency, outcome });

    if (outcome === "failure") {
      baseLogger.warn(
        {
          event: "expert_dependency_failed",
          dependency,
          reason,
          durationMs: Math.round(durationSeconds * 1000),
          ...activeTraceFields(),
        },
        "expert_dependency_failed",
      );
    }
  } catch {
    // Telemetry must never change the answer.
  }
}

/** The status code of a provider error, when it carries one (the OpenAI SDK errors do). */
function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const { status } = error as { status?: unknown };

    return typeof status === "number" ? status : undefined;
  }

  return undefined;
}

/**
 * The closed `reason` of a failed call to the chat model, from the HTTP status or the error name.
 * Nothing of the provider's message is read: it can echo parts of the prompt.
 */
export function modelFailureReason(error: unknown): KnowledgeFailureReason {
  const status = statusOf(error);
  const name = error instanceof Error ? error.name : "";

  if (status === 429) {
    return "rate_limited";
  }

  if (status === 401 || status === 403) {
    return "unauthorized";
  }

  if (status === 408 || /timeout/i.test(name)) {
    return "timeout";
  }

  if (status !== undefined) {
    return status >= 500 ? "server_error" : "rejected";
  }

  return /connection/i.test(name) ? "connection" : failureReasonOf(undefined);
}

/**
 * Runs one node of the graph (`expert.retrieve`, `expert.generate`) inside its own span, a child of
 * the answer span. A failure gets status `ERROR` and the closed `expert.error_code`, never the
 * message; a stop pressed by the user (`signal` aborted) is not an error. Rethrows untouched.
 */
export async function traceExpertNode<T>(
  name: "expert.retrieve" | "expert.generate",
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
  errorCodeOf: (error: unknown) => string,
): Promise<T> {
  return trace.getTracer(TRACER_NAME).startActiveSpan(name, async (span) => {
    try {
      return await run();
    } catch (error) {
      if (signal?.aborted === true) {
        span.setAttribute("expert.outcome", "aborted");
      } else {
        span.setAttribute("expert.error_code", errorCodeOf(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
      }

      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Runs the call to the chat model (the whole streamed answer) inside a CLIENT span `gen_ai.chat`,
 * counts it as a call to `dependency` and records the token counts the provider reported. The
 * span carries the operation and the provider name only; a failure adds the closed error code.
 * A stop pressed by the user is neither an error nor a failed call. Rethrows untouched.
 */
export async function traceModelCall<T>(
  dependency: ExpertDependency,
  signal: AbortSignal | undefined,
  run: (span: Span) => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();

  return trace.getTracer(TRACER_NAME).startActiveSpan(
    "gen_ai.chat",
    {
      kind: SpanKind.CLIENT,
      attributes: { "gen_ai.operation.name": "chat", "gen_ai.provider.name": dependency },
    },
    async (span) => {
      let reason: KnowledgeFailureReason | "none" = "none";
      let outcome: DependencyOutcome | "stopped" = "success";

      try {
        return await run(span);
      } catch (error) {
        if (signal?.aborted === true) {
          outcome = "stopped";
        } else {
          outcome = "failure";
          reason = modelFailureReason(error);
          span.setAttribute("expert.error_code", reason);
          span.setStatus({ code: SpanStatusCode.ERROR });
        }

        throw error;
      } finally {
        // Ended first, but still the active span: the failure log gets its trace and span ids.
        span.end();

        if (outcome !== "stopped") {
          recordDependencyCall(dependency, outcome, reason, (performance.now() - startedAt) / 1000);
        }
      }
    },
  );
}
