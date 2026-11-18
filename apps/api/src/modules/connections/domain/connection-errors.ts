import type { ConnectionErrorCode } from "./connection";

export type InvalidUploadCode =
  | "UNSUPPORTED_FILE"
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "IMAGE_TOO_LARGE"
  /** An audio or video whose length the metadata cannot tell (spec 0028). */
  | "MEDIA_UNREADABLE"
  | "MEDIA_TOO_LONG";

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

/** The user already has the most media being processed at once (spec 0028, R5). */
export class TooManyProcessingError extends Error {
  constructor() {
    super("Too many media are being processed.");
    this.name = "TooManyProcessingError";
  }
}

/** The user used the day's minutes of media processing (spec 0028, R10). */
export class MediaDailyLimitError extends Error {
  constructor() {
    super("Daily media processing limit reached.");
    this.name = "MediaDailyLimitError";
  }
}

/** Audio and video cannot be processed here: no provider key (spec 0028, R6). */
export class MediaUnavailableError extends Error {
  constructor() {
    super("Media processing is unavailable.");
    this.name = "MediaUnavailableError";
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
