import type { Connection } from "../../domain/connection";
import {
  ConnectionLimitReachedError,
  InvalidUploadError,
  MediaDailyLimitError,
  MediaUnavailableError,
  TooManyProcessingError,
} from "../../domain/connection-errors";
import type {
  ConnectionRepository,
  ConnectionTelemetry,
  ContentHasher,
} from "../../domain/connection-ports";
import {
  isMediaKind,
  isStaleProcessing,
  kindOfFileName,
  MAX_CONNECTIONS_PER_USER,
  MAX_MEDIA_SECONDS_PER_DAY,
  MAX_SIMULTANEOUS_MEDIA_PER_USER,
  sanitizeFileName,
  STALE_MEDIA_PROCESSING_MS,
  staleProcessingMsOf,
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
 * Audio and video (spec 0028) also need the media provider (`MEDIA_UNAVAILABLE` without it), fewer
 * than 2 other media being processed (`TOO_MANY_PROCESSING`) and minutes left in the day
 * (`MEDIA_DAILY_LIMIT`), checked only when processing is about to start: a duplicate is free.
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
    /** Whether audio and video can be processed (a provider key is configured). */
    private readonly mediaAvailable: () => boolean = () => false,
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

    const { durationSeconds } = assertUploadContent(kind, bytes);

    const contentHash = this.hasher.sha256(bytes);
    const existing = await this.repository.findByContentHash(userId, contentHash);

    if (existing !== null) {
      return this.reuse(userId, existing, bytes, durationSeconds, startedAt);
    }

    if ((await this.repository.countByUser(userId)) >= MAX_CONNECTIONS_PER_USER) {
      throw new ConnectionLimitReachedError();
    }

    await this.admitMedia(userId, kind, durationSeconds);

    const inserted = await this.repository.insertProcessing(userId, {
      kind,
      name: sanitizeFileName(fileName, kind),
      sizeBytes: bytes.byteLength,
      durationSeconds,
      contentHash,
    });

    if (!inserted.created) {
      // Another request inserted the same content between our lookup and our insert.
      return this.reuse(userId, inserted.connection, bytes, durationSeconds, startedAt);
    }

    this.processor.enqueue({ userId, connection: inserted.connection, bytes, clearFirst: false });

    return { connection: inserted.connection, deduplicated: false };
  }

  /**
   * The checks that only audio and video have, before anything is written (spec 0028): the provider
   * is configured, the user has a free slot and minutes left in the day. The minutes are booked here.
   */
  private async admitMedia(
    userId: string,
    kind: Connection["kind"],
    durationSeconds: number | null,
  ): Promise<void> {
    if (!isMediaKind(kind)) {
      return;
    }

    if (!this.mediaAvailable()) {
      throw new MediaUnavailableError();
    }

    const staleBefore = new Date(this.now().getTime() - STALE_MEDIA_PROCESSING_MS);

    if (
      (await this.repository.countActiveMedia(userId, staleBefore)) >=
      MAX_SIMULTANEOUS_MEDIA_PER_USER
    ) {
      throw new TooManyProcessingError();
    }

    if (
      !(await this.repository.reserveMediaSeconds(
        userId,
        durationSeconds ?? 1,
        MAX_MEDIA_SECONDS_PER_DAY,
      ))
    ) {
      throw new MediaDailyLimitError();
    }
  }

  private async reuse(
    userId: string,
    found: Connection,
    bytes: Uint8Array,
    durationSeconds: number | null,
    startedAt: number,
  ): Promise<UploadConnectionResult> {
    let connection = found;

    if (isStaleProcessing(connection, this.now())) {
      // The worker is gone (API restart): the connection is failed and this upload retries it.
      const cutoff = new Date(this.now().getTime() - staleProcessingMsOf(connection.kind));

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
      await this.admitMedia(userId, connection.kind, durationSeconds);

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
