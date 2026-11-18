/** Kinds of connection this slice can ingest. URLs, audio and video come in phase 2. */
export const CONNECTION_KINDS = ["pdf", "txt", "md", "image"] as const;

export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export type ConnectionStatus = "processing" | "ready" | "failed";

/** Why a connection is `failed`. A closed set: the interface maps each code to a fixed message. */
export const CONNECTION_ERROR_CODES = [
  "NO_EXTRACTABLE_TEXT",
  "PDF_PROTECTED",
  "TOO_MANY_CHUNKS",
  "PROCESSING_UNAVAILABLE",
  "CONTENT_NOT_PROCESSABLE",
] as const;

export type ConnectionErrorCode = (typeof CONNECTION_ERROR_CODES)[number];

export interface Connection {
  id: string;
  userId: string;
  kind: ConnectionKind;
  /** The user's own file name: shown back to them, never logged. */
  name: string;
  sizeBytes: number;
  /** SHA-256 of the bytes (lower-case hex): the identity of the content. Never logged. */
  contentHash: string;
  status: ConnectionStatus;
  chunkCount: number;
  errorCode: ConnectionErrorCode | null;
  createdAt: Date;
  /** Starts the stale `processing` clock. */
  updatedAt: Date;
}
