import { KnowledgeIndexUnavailableError, type KnowledgeIndex } from "../../../knowledge";
import {
  ConnectionBusyError,
  ConnectionIndexUnavailableError,
} from "../../domain/connection-errors";
import type {
  ConnectionRepository,
  ConnectionTelemetry,
  DeletionOutcome,
} from "../../domain/connection-ports";
import { STALE_MEDIA_PROCESSING_MS, STALE_PROCESSING_MS } from "../../domain/connection-rules";

export interface DeleteAllConnectionsInput {
  /** From the session, never from the request. */
  userId: string;
}

/**
 * Deletes every connection of the user (R6): the whole tenant in the index first, then all rows.
 * Refused as a whole (`ConnectionBusyError`, nothing deleted) while any connection is being
 * processed. Idempotent: a user without connections, or a repeat, is a success. When the index
 * fails nothing else is touched, so repeating the request finishes the job.
 */
export class DeleteAllConnections {
  constructor(
    private readonly repository: ConnectionRepository,
    private readonly index: KnowledgeIndex,
    private readonly telemetry: ConnectionTelemetry,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute({ userId }: DeleteAllConnectionsInput): Promise<void> {
    const startedAt = this.now();
    let outcome: DeletionOutcome = "error";

    try {
      await this.run(userId);
      outcome = "success";
    } catch (error) {
      outcome =
        error instanceof ConnectionBusyError
          ? "processing"
          : error instanceof ConnectionIndexUnavailableError
            ? "index_unavailable"
            : "error";

      throw error;
    } finally {
      this.telemetry.recordDeletion(
        "all",
        outcome,
        (this.now().getTime() - startedAt.getTime()) / 1000,
      );
    }
  }

  private async run(userId: string): Promise<void> {
    const staleBefore = new Date(this.now().getTime() - STALE_PROCESSING_MS);
    const mediaStaleBefore = new Date(this.now().getTime() - STALE_MEDIA_PROCESSING_MS);

    if (await this.repository.hasActiveProcessing(userId, staleBefore, mediaStaleBefore)) {
      throw new ConnectionBusyError();
    }

    try {
      await this.index.deleteAllForUser(userId);
    } catch (error) {
      throw error instanceof KnowledgeIndexUnavailableError
        ? new ConnectionIndexUnavailableError()
        : error;
    }

    await this.repository.deleteAllSettled(userId, staleBefore, mediaStaleBefore);
  }
}
