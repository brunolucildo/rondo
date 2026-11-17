import { KnowledgeIndexUnavailableError, type KnowledgeIndex } from "../../../knowledge";
import {
  ConnectionBusyError,
  ConnectionIndexUnavailableError,
  ConnectionNotFoundError,
} from "../../domain/connection-errors";
import type {
  ConnectionRepository,
  ConnectionTelemetry,
  DeletionOutcome,
} from "../../domain/connection-ports";
import { isStaleProcessing, STALE_PROCESSING_MS } from "../../domain/connection-rules";

export interface DeleteConnectionInput {
  /** From the session, never from the request. */
  userId: string;
  connectionId: string;
}

/**
 * Deletes one connection completely (R2 to R4): first its vectors in the index, then its row (which
 * carries the deduplication identity), in this order, so a failure in the middle never leaves
 * vectors without a record. Both steps are idempotent: after an index failure the row is still
 * there and repeating the request finishes the job; after a success the repeat is a plain
 * `ConnectionNotFoundError`. Another user's connection is indistinguishable from an unknown id.
 * A connection being processed is refused (`ConnectionBusyError`); one stuck for over 15 minutes
 * counts as `failed` (spec 0023) and can be deleted.
 */
export class DeleteConnection {
  constructor(
    private readonly repository: ConnectionRepository,
    private readonly index: KnowledgeIndex,
    private readonly telemetry: ConnectionTelemetry,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute({ userId, connectionId }: DeleteConnectionInput): Promise<void> {
    const startedAt = this.now();
    let outcome: DeletionOutcome = "error";

    try {
      await this.run(userId, connectionId);
      outcome = "success";
    } catch (error) {
      outcome =
        error instanceof ConnectionNotFoundError
          ? "not_found"
          : error instanceof ConnectionBusyError
            ? "processing"
            : error instanceof ConnectionIndexUnavailableError
              ? "index_unavailable"
              : "error";

      throw error;
    } finally {
      this.telemetry.recordDeletion(
        "single",
        outcome,
        (this.now().getTime() - startedAt.getTime()) / 1000,
      );
    }
  }

  private async run(userId: string, connectionId: string): Promise<void> {
    const connection = await this.repository.findById(userId, connectionId);

    if (connection === null) {
      throw new ConnectionNotFoundError();
    }

    if (connection.status === "processing" && !isStaleProcessing(connection, this.now())) {
      throw new ConnectionBusyError();
    }

    try {
      await this.index.deleteByConnection(userId, connectionId);
    } catch (error) {
      throw error instanceof KnowledgeIndexUnavailableError
        ? new ConnectionIndexUnavailableError()
        : error;
    }

    const staleBefore = new Date(this.now().getTime() - STALE_PROCESSING_MS);

    if (await this.repository.deleteSettled(userId, connectionId, staleBefore)) {
      return;
    }

    // No row was deleted: either another request finished first (nothing left to do) or the file
    // was sent again meanwhile and its processing started (the row stays).
    if ((await this.repository.findById(userId, connectionId)) !== null) {
      throw new ConnectionBusyError();
    }
  }
}
