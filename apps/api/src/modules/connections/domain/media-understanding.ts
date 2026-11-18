/**
 * The port to a model that understands audio and video (spec 0028). The adapter (Gemini) lives in
 * infrastructure; tests use a fake. Implementations send the bytes to the provider, read the
 * answer and delete what they uploaded in every outcome.
 */

export type MediaKind = "audio" | "video";

/** Why the provider gave no text. A closed set: the extractor maps each to a connection error. */
export type MediaUnderstandingFailure =
  /** No speech and nothing useful to describe. */
  | "NO_CONTENT"
  /** Corrupted file or a codec the provider cannot read. */
  | "UNREADABLE"
  /** The provider refused the content by its policy. */
  | "REFUSED"
  /** Rate limit, server error, network, timeout or a refused key: trying again later may work. */
  | "UNAVAILABLE";

/** Fixed message: never the provider's, which can echo content or identifiers. */
export class MediaUnderstandingError extends Error {
  constructor(readonly code: MediaUnderstandingFailure) {
    super(`Media understanding failed: ${code}`);
    this.name = "MediaUnderstandingError";
  }
}

export interface MediaUnderstandingRequest {
  kind: MediaKind;
  /** The whole file. Never written to disk by the adapter. */
  bytes: Uint8Array;
  /** `audio/mpeg` or `video/mp4`. */
  mimeType: string;
  /** The fixed instruction (`buildMediaInstruction`). */
  instruction: string;
}

export interface MediaUnderstanding {
  /** False when no provider is configured (no key): the upload is refused with `MEDIA_UNAVAILABLE`. */
  isAvailable(): boolean;
  /**
   * The timed transcript of the media (`[MM:SS] text` lines; for a video also `SCENE:` lines), or
   * the sentinel `NO_CONTENT`. Throws `MediaUnderstandingError`.
   */
  understand(request: MediaUnderstandingRequest): Promise<string>;
}

export const MEDIA_MIME_TYPES: Readonly<Record<MediaKind, string>> = {
  audio: "audio/mpeg",
  video: "video/mp4",
};
