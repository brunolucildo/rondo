import type { Connection, ConnectionErrorCode, ConnectionKind } from "./connection";

export interface NewConnection {
  kind: ConnectionKind;
  name: string;
  sizeBytes: number;
  /** Length of an audio or video, read from its metadata (spec 0028). */
  durationSeconds?: number | null;
  contentHash: string;
}

export interface InsertedConnection {
  connection: Connection;
  /** False when another request inserted the same content first: `connection` is that one. */
  created: boolean;
}

/**
 * Persistence of connections. Every method takes the `userId` of the session and touches only
 * that user's rows: another user's id never matches.
 */
export interface ConnectionRepository {
  findById(userId: string, connectionId: string): Promise<Connection | null>;
  findByContentHash(userId: string, contentHash: string): Promise<Connection | null>;
  countByUser(userId: string): Promise<number>;
  /** True when the user has at least one `ready` connection (what the experts may search). */
  hasReadyConnection(userId: string): Promise<boolean>;
  /** Inserts as `processing`; on a duplicate `(user, hash)` returns the existing row, `created: false`. */
  insertProcessing(userId: string, connection: NewConnection): Promise<InsertedConnection>;
  /** `failed` to `processing`, atomically; `null` when it is no longer `failed` (someone else took it). */
  claimFailed(userId: string, connectionId: string): Promise<Connection | null>;
  /** `processing` older than `cutoff` to `failed`; `null` when it is not stale (or not processing). */
  failIfStale(
    userId: string,
    connectionId: string,
    cutoff: Date,
    errorCode: ConnectionErrorCode,
  ): Promise<Connection | null>;
  markReady(userId: string, connectionId: string, chunkCount: number): Promise<void>;
  markFailed(userId: string, connectionId: string, errorCode: ConnectionErrorCode): Promise<void>;
  /** Every connection of the user, the most recent first. */
  listByUser(userId: string): Promise<Connection[]>;
  /**
   * True when the user has a connection being processed that is not stale (`updatedAt >=
   * staleBefore`). Audio and video go stale later: `mediaStaleBefore` (defaults to `staleBefore`).
   */
  hasActiveProcessing(userId: string, staleBefore: Date, mediaStaleBefore?: Date): Promise<boolean>;
  /**
   * Deletes the row of one connection of the user unless it is being processed right now (not
   * stale). Returns whether a row was deleted. The deduplication identity goes with the row.
   */
  deleteSettled(
    userId: string,
    connectionId: string,
    staleBefore: Date,
    mediaStaleBefore?: Date,
  ): Promise<boolean>;
  /** Deletes every row of the user except the ones being processed right now. Returns the count. */
  deleteAllSettled(userId: string, staleBefore: Date, mediaStaleBefore?: Date): Promise<number>;
  /** The ids, among `connectionIds`, that are still connections of the user. */
  findExistingIds(userId: string, connectionIds: readonly string[]): Promise<string[]>;
  /** Audio and video of the user being processed right now (not stale: `updatedAt >= staleBefore`). */
  countActiveMedia(userId: string, staleBefore: Date): Promise<number>;
  /**
   * Books `seconds` of media processing in the user's rolling 24 hours (spec 0028, R10) unless the
   * day's total would pass `maxSecondsPerDay`. Returns whether it was booked. The ledger outlives
   * the connection: deleting a media does not give the minutes back.
   */
  reserveMediaSeconds(userId: string, seconds: number, maxSecondsPerDay: number): Promise<boolean>;
}

/**
 * One piece of extracted text, with its page when the source has pages (one-based) or the second
 * it starts at when the source is an audio or a video.
 */
export interface ExtractedSection {
  text: string;
  page?: number;
  startSeconds?: number;
}

/**
 * Reads the text of one kind of file. Implementations never keep a copy of the bytes after they
 * return, and throw `ConnectionProcessingError` when the file has nothing to extract.
 */
export interface DocumentExtractor {
  extract(bytes: Uint8Array): Promise<ExtractedSection[]>;
}

/** Splits extracted text into the pieces that get embedded, keeping the page of each. */
export interface TextChunker {
  chunk(sections: readonly ExtractedSection[]): Promise<ExtractedSection[]>;
}

export interface ContentHasher {
  /** SHA-256 of the bytes as lower-case hex. */
  sha256(bytes: Uint8Array): string;
}

/** What one ingestion came to, as telemetry sees it: closed sets and numbers, never content. */
export interface IngestionResult {
  outcome: "success" | "failure";
  /** `none` on success, else the lower-case error code of the failed connection. */
  reason: "none" | Lowercase<ConnectionErrorCode>;
  deduplicated: boolean;
  chunkCount: number;
  /** Seconds of audio or video processed; absent for the other kinds. Telemetry derives the cost per minute. */
  mediaSeconds?: number;
}

/** `single`: one connection; `all`: every connection of the user. */
export type DeletionScope = "single" | "all";

/** Closed set of what a deletion request came to. */
export type DeletionOutcome =
  | "success"
  | "not_found"
  | "processing"
  | "index_unavailable"
  | "error";

export interface ConnectionTelemetry {
  /** Runs one processing inside a span and records the counter, the duration and the log. */
  traceIngestion(
    kind: ConnectionKind,
    run: () => Promise<IngestionResult>,
  ): Promise<IngestionResult>;
  /** A dedup answer: the content was already connected, nothing was processed. */
  recordDeduplicated(kind: ConnectionKind, durationSeconds: number): void;
  /** One deletion request: scope, outcome and duration only, never a name, id or content. */
  recordDeletion(scope: DeletionScope, outcome: DeletionOutcome, durationSeconds: number): void;
}
