import type { ConnectionErrorCode } from "./connection";

export type InvalidUploadCode =
  | "UNSUPPORTED_FILE"
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "IMAGE_TOO_LARGE";

/** The file breaks a rule checked before any processing. The message is fixed, never the file's. */
export class InvalidUploadError extends Error {
  constructor(readonly code: InvalidUploadCode) {
    super(`Invalid upload: ${code}`);
    this.name = "InvalidUploadError";
  }
}

export class ConnectionLimitReachedError extends Error {
  constructor() {
    super("Connection limit reached.");
    this.name = "ConnectionLimitReachedError";
  }
}

export class ConnectionNotFoundError extends Error {
  constructor() {
    super("Connection not found.");
    this.name = "ConnectionNotFoundError";
  }
}

/** A connection (or one of them, on "delete all") is still being processed: it cannot be deleted yet. */
export class ConnectionBusyError extends Error {
  constructor() {
    super("Connection is still processing.");
    this.name = "ConnectionBusyError";
  }
}

/** The vector index could not remove the vectors: nothing else was deleted, trying again is safe. */
export class ConnectionIndexUnavailableError extends Error {
  constructor() {
    super("The knowledge index is unavailable.");
    this.name = "ConnectionIndexUnavailableError";
  }
}

/** Extraction or chunking ended with a reason the user can act on. Fixed message. */
export class ConnectionProcessingError extends Error {
  constructor(readonly code: ConnectionErrorCode) {
    super(`Connection processing failed: ${code}`);
    this.name = "ConnectionProcessingError";
  }
}

/** The vision model could not be reached in time (timeout, 429, 5xx, no key): trying again may work. */
export class VisionUnavailableError extends Error {
  constructor() {
    super("The vision model is unavailable.");
    this.name = "VisionUnavailableError";
  }
}

/** The provider refused to describe the image (content policy, unreadable image): retrying is useless. */
export class VisionRefusedError extends Error {
  constructor() {
    super("The vision model refused the image.");
    this.name = "VisionRefusedError";
  }
}
