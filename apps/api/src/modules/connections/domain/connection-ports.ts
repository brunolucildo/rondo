import type { Connection, ConnectionErrorCode, ConnectionKind } from "./connection";

export interface NewConnection {
  kind: ConnectionKind;
  name: string;
  sizeBytes: number;
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
}

/** One piece of extracted text, with its page when the source has pages (one-based). */
export interface ExtractedSection {
  text: string;
  page?: number;
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
}

export interface ConnectionTelemetry {
  /** Runs one processing inside a span and records the counter, the duration and the log. */
  traceIngestion(
    kind: ConnectionKind,
    run: () => Promise<IngestionResult>,
  ): Promise<IngestionResult>;
  /** A dedup answer: the content was already connected, nothing was processed. */
  recordDeduplicated(kind: ConnectionKind, durationSeconds: number): void;
}
