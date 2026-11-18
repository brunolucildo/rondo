import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { DURATION_BUCKETS_SECONDS } from "./duration-buckets";
import { baseLogger } from "./logger";

/**
 * Telemetry of the ingestion of connections (spec `0023`).
 *
 * Content-free by construction: labels, span attributes and log fields come from closed sets or
 * are numbers. Never the file name, the content, the extracted text, the hash, a `userId` or a
 * `connectionId`.
 */

const METER_NAME = "rondo-api";

/** Processing a minute of media takes seconds to a few minutes: the default buckets stop at 10 s. */
const MEDIA_PER_MINUTE_BUCKETS_SECONDS = [0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 60, 120];

export type ConnectionIngestionKind = "pdf" | "txt" | "md" | "audio" | "video";
export type ConnectionIngestionOutcome = "success" | "failure";

/** Closed set for the `reason` of a failed ingestion (the lower-case error codes). */
export type ConnectionIngestionReason =
  | "none"
  | "no_extractable_text"
  | "pdf_protected"
  | "too_many_chunks"
  | "processing_unavailable"
  | "media_unreadable"
  | "content_not_processable";

export interface ConnectionIngestionResult {
  outcome: ConnectionIngestionOutcome;
  reason: ConnectionIngestionReason;
  /** True when the content was already connected and nothing was processed. */
  deduplicated: boolean;
  chunkCount: number;
  /** Seconds of audio or video processed (spec 0028); absent for the other kinds. */
  mediaSeconds?: number;
}

function createInstruments() {
  const meter = metrics.getMeter(METER_NAME);

  return {
    ingestions: meter.createCounter("connection.ingestions", {
      description: "Connection ingestions (processed or deduplicated), by outcome and kind.",
      unit: "{ingestion}",
    }),
    duration: meter.createHistogram("connection.ingestion.duration", {
      description: "Time to ingest a connection, from the start of processing to its final status.",
      unit: "s",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS },
    }),
    deletions: meter.createCounter("connection.deletions", {
      description: "Connection deletion requests (spec 0025), by scope and outcome.",
      unit: "{deletion}",
    }),
    mediaMinutes: meter.createCounter("connection.media.minutes", {
      description:
        "Minutes of audio and video sent to be processed (spec 0028), by kind and outcome.",
      unit: "min",
    }),
    mediaProcessingPerMinute: meter.createHistogram(
      "connection.media.processing_per_media_minute",
      {
        description:
          "Seconds spent processing one minute of audio or video (spec 0028), by kind and outcome.",
        unit: "s",
        advice: { explicitBucketBoundaries: MEDIA_PER_MINUTE_BUCKETS_SECONDS },
      },
    ),
    mediaCleanups: meter.createCounter("connection.media.cleanups", {
      description:
        "Deletions of the file sent to the media provider (spec 0028), by outcome: deleted, pending (failed, retried later) or retried.",
      unit: "{cleanup}",
    }),
  };
}

let instruments: ReturnType<typeof createInstruments> | undefined;

// Created on first use: the API meter provider is only registered when the SDK starts.
function getInstruments() {
  instruments ??= createInstruments();

  return instruments;
}

export type ConnectionDeletionScope = "single" | "all";
export type ConnectionDeletionOutcome =
  | "success"
  | "not_found"
  | "processing"
  | "index_unavailable"
  | "error";

/**
 * Counter and `connection_deleted` log of one deletion request (spec 0025): scope, outcome and
 * duration only. Never the file name, a `connectionId` or a `userId`. Never throws.
 */
export function recordConnectionDeletion(
  scope: ConnectionDeletionScope,
  outcome: ConnectionDeletionOutcome,
  durationSeconds: number,
): void {
  try {
    getInstruments().deletions.add(1, { scope, outcome });

    const fields = {
      event: "connection_deleted",
      scope,
      outcome,
      durationMs: Math.round(durationSeconds * 1000),
    };

    if (outcome === "success" || outcome === "not_found" || outcome === "processing") {
      baseLogger.info(fields, "connection_deleted");
    } else {
      baseLogger.warn(fields, "connection_deleted");
    }
  } catch {
    // Telemetry must never change the answer.
  }
}

export type MediaCleanupOutcome = "deleted" | "pending" | "retried";

/**
 * Counter and log of the deletion of a file at the media provider (spec 0028, R4): only the
 * outcome, never the provider's file name or anything of the file. A `pending` one is repeated by
 * the next sweep. Never throws.
 */
export function recordMediaCleanup(outcome: MediaCleanupOutcome, pending: number): void {
  try {
    getInstruments().mediaCleanups.add(1, { outcome });

    if (outcome === "pending") {
      baseLogger.warn({ event: "media_cleanup_pending", pending }, "media_cleanup_pending");
    }
  } catch {
    // Telemetry must never change the answer.
  }
}

/** Counter, histogram and `connection_ingested` log of one finished ingestion. Never throws. */
export function recordConnectionIngestion(
  kind: ConnectionIngestionKind,
  result: ConnectionIngestionResult,
  durationSeconds: number,
): void {
  try {
    const { ingestions, duration } = getInstruments();
    const attributes = {
      outcome: result.outcome,
      kind,
      deduplicated: result.deduplicated,
    };

    ingestions.add(1, attributes);
    duration.record(durationSeconds, attributes);

    if (result.mediaSeconds !== undefined && result.mediaSeconds > 0) {
      const minutes = result.mediaSeconds / 60;
      const { mediaMinutes, mediaProcessingPerMinute } = getInstruments();
      const mediaAttributes = { outcome: result.outcome, kind };

      mediaMinutes.add(minutes, mediaAttributes);
      mediaProcessingPerMinute.record(durationSeconds / minutes, mediaAttributes);
    }

    const fields = {
      event: "connection_ingested",
      kind,
      outcome: result.outcome,
      reason: result.reason,
      deduplicated: result.deduplicated,
      chunkCount: result.chunkCount,
      ...(result.mediaSeconds === undefined ? {} : { mediaSeconds: result.mediaSeconds }),
      durationMs: Math.round(durationSeconds * 1000),
    };

    if (result.outcome === "success") {
      baseLogger.info(fields, "connection_ingested");
    } else {
      baseLogger.warn(fields, "connection_ingested");
    }
  } catch {
    // Telemetry must never change the answer.
  }
}

/**
 * Runs the processing of one connection inside the span `connection.ingest` and records the
 * result when it ends. The span carries the kind, the outcome, the reason and the chunk count only.
 */
export async function traceConnectionIngestion(
  kind: ConnectionIngestionKind,
  run: () => Promise<ConnectionIngestionResult>,
): Promise<ConnectionIngestionResult> {
  const startedAt = performance.now();

  return trace
    .getTracer(METER_NAME)
    .startActiveSpan(
      "connection.ingest",
      { attributes: { "connection.kind": kind } },
      async (span) => {
        const result = await run().catch((): ConnectionIngestionResult => ({
          outcome: "failure",
          reason: "processing_unavailable",
          deduplicated: false,
          chunkCount: 0,
        }));

        span.setAttribute("connection.outcome", result.outcome);
        span.setAttribute("connection.reason", result.reason);
        span.setAttribute("connection.chunk_count", result.chunkCount);

        if (result.outcome === "failure") {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }

        span.end();
        recordConnectionIngestion(kind, result, (performance.now() - startedAt) / 1000);

        return result;
      },
    );
}
