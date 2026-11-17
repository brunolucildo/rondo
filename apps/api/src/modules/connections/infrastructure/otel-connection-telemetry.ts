import {
  recordConnectionDeletion,
  recordConnectionIngestion,
  traceConnectionIngestion,
} from "../../../observability/connection-telemetry";
import type { ConnectionKind } from "../domain/connection";
import type {
  ConnectionTelemetry,
  DeletionOutcome,
  DeletionScope,
  IngestionResult,
} from "../domain/connection-ports";

/** `ConnectionTelemetry` over OpenTelemetry and the structured logger. */
export class OtelConnectionTelemetry implements ConnectionTelemetry {
  traceIngestion(
    kind: ConnectionKind,
    run: () => Promise<IngestionResult>,
  ): Promise<IngestionResult> {
    return traceConnectionIngestion(kind, run);
  }

  recordDeduplicated(kind: ConnectionKind, durationSeconds: number): void {
    recordConnectionIngestion(
      kind,
      { outcome: "success", reason: "none", deduplicated: true, chunkCount: 0 },
      durationSeconds,
    );
  }

  recordDeletion(scope: DeletionScope, outcome: DeletionOutcome, durationSeconds: number): void {
    recordConnectionDeletion(scope, outcome, durationSeconds);
  }
}
