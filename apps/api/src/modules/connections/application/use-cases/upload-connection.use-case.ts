import type { Connection } from "../../domain/connection";
import { ConnectionLimitReachedError, InvalidUploadError } from "../../domain/connection-errors";
import type {
  ConnectionRepository,
  ConnectionTelemetry,
  ContentHasher,
} from "../../domain/connection-ports";
import {
  isStaleProcessing,
  kindOfFileName,
  MAX_CONNECTIONS_PER_USER,
  sanitizeFileName,
  STALE_PROCESSING_MS,
} from "../../domain/connection-rules";
import { assertUploadContent } from "../../domain/upload-validation";
import type { ConnectionProcessor } from "../services/connection-processor";

export interface UploadConnectionInput {
  /** From the session, never from the request. */
  userId: string;
  fileName: string;
  bytes: Uint8Array;
}

export interface UploadConnectionResult {
  connection: Connection;
  /** True when the content was already connected: nothing new was created or reprocessed. */
  deduplicated: boolean;
}

/**
 * Connects a file: validates it, takes its identity (SHA-256 of the bytes) and decides between
 * reusing a connection of the same user and processing a new one (R2, R3, R4).
 *
 * - `ready` or `processing` with the same content: that connection comes back (`deduplicated`), no
 *   file is written and nothing is embedded.
 * - `failed`: it is claimed (one request wins) and processed again.
 * - nothing yet: the 50 connection limit is checked (only a new connection counts), the row is
 *   inserted and processing is scheduled. Two simultaneous uploads of the same content meet at the
 *   unique `(user, hash)` index: one creates, the other receives the same row.
 *
 * The use case never processes the file itself: it hands it to the `ConnectionProcessor`.
 */
export class UploadConnection {
  constructor(
    private readonly repository: ConnectionRepository,
    private readonly hasher: ContentHasher,
    private readonly processor: ConnectionProcessor,
    private readonly telemetry: ConnectionTelemetry,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute({
    userId,
    fileName,
    bytes,
  }: UploadConnectionInput): Promise<UploadConnectionResult> {
    const startedAt = performance.now();
    const kind = kindOfFileName(fileName);

    if (kind === null) {
      throw new InvalidUploadError("UNSUPPORTED_FILE");
    }

    assertUploadContent(kind, bytes);

    const contentHash = this.hasher.sha256(bytes);
    const existing = await this.repository.findByContentHash(userId, contentHash);

    if (existing !== null) {
      return this.reuse(userId, existing, bytes, startedAt);
    }

    if ((await this.repository.countByUser(userId)) >= MAX_CONNECTIONS_PER_USER) {
      throw new ConnectionLimitReachedError();
    }

    const inserted = await this.repository.insertProcessing(userId, {
      kind,
      name: sanitizeFileName(fileName, kind),
      sizeBytes: bytes.byteLength,
      contentHash,
    });

    if (!inserted.created) {
      // Another request inserted the same content between our lookup and our insert.
      return this.reuse(userId, inserted.connection, bytes, startedAt);
    }

    this.processor.enqueue({ userId, connection: inserted.connection, bytes, clearFirst: false });

    return { connection: inserted.connection, deduplicated: false };
  }

  private async reuse(
    userId: string,
    found: Connection,
    bytes: Uint8Array,
    startedAt: number,
  ): Promise<UploadConnectionResult> {
    let connection = found;

    if (isStaleProcessing(connection, this.now())) {
      // The worker is gone (API restart): the connection is failed and this upload retries it.
      const cutoff = new Date(this.now().getTime() - STALE_PROCESSING_MS);

      connection =
        (await this.repository.failIfStale(
          userId,
          connection.id,
          cutoff,
          "PROCESSING_UNAVAILABLE",
        )) ??
        (await this.repository.findById(userId, connection.id)) ??
        connection;
    }

    if (connection.status === "failed") {
      const claimed = await this.repository.claimFailed(userId, connection.id);

      if (claimed !== null) {
        this.processor.enqueue({ userId, connection: claimed, bytes, clearFirst: true });

        return { connection: claimed, deduplicated: false };
      }

      connection = (await this.repository.findById(userId, connection.id)) ?? connection;
    }

    this.telemetry.recordDeduplicated(connection.kind, (performance.now() - startedAt) / 1000);

    return { connection, deduplicated: true };
  }
}
