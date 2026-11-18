/** Kinds of connection this slice can ingest. Images, audio and video come in phase 2. */
export const CONNECTION_KINDS = ["pdf", "txt", "md", "url"] as const;

export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/** The kinds that come as bytes of a file: they are read by an extractor of their own. */
export type FileConnectionKind = Exclude<ConnectionKind, "url">;

export type ConnectionStatus = "processing" | "ready" | "failed";

/** Why a connection is `failed`. A closed set: the interface maps each code to a fixed message. */
export const CONNECTION_ERROR_CODES = [
  "NO_EXTRACTABLE_TEXT",
  "PDF_PROTECTED",
  "TOO_MANY_CHUNKS",
  "PROCESSING_UNAVAILABLE",
  // A link that could not be fetched or read (spec 0027): the interface shows the same message
  // whether the code comes from a refused request or from a `failed` connection.
  "URL_NOT_ALLOWED",
  "FETCH_FAILED",
  "FETCH_TIMEOUT",
  "RESPONSE_TOO_LARGE",
  "UNSUPPORTED_CONTENT_TYPE",
  "TOO_MANY_REDIRECTS",
] as const;

export type ConnectionErrorCode = (typeof CONNECTION_ERROR_CODES)[number];

export interface Connection {
  id: string;
  userId: string;
  kind: ConnectionKind;
  /**
   * The user's own file name, or for a link its title or `host/path` (never the query): shown back
   * to them, never logged.
   */
  name: string;
  sizeBytes: number;
  /** SHA-256 of the bytes (lower-case hex): the identity of the content. Never logged. */
  contentHash: string;
  /** SHA-256 of the canonical URL of a link (spec 0027): its identity before any request. Never exposed. */
  urlHash?: string | null;
  status: ConnectionStatus;
  chunkCount: number;
  errorCode: ConnectionErrorCode | null;
  createdAt: Date;
  /** Starts the stale `processing` clock. */
  updatedAt: Date;
}
