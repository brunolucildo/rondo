import type { ConnectionErrorCode } from "../domain/connection";
import { ConnectionProcessingError } from "../domain/connection-errors";
import type { DocumentExtractor, ExtractedSection } from "../domain/connection-ports";
import {
  MEDIA_MIME_TYPES,
  type MediaKind,
  MediaUnderstandingError,
  type MediaUnderstanding,
  type MediaUnderstandingFailure,
} from "../domain/media-understanding";
import { buildMediaInstruction, parseTimedTranscript } from "../domain/timed-transcript";

const CODE_OF_FAILURE: Readonly<Record<MediaUnderstandingFailure, ConnectionErrorCode>> = {
  NO_CONTENT: "NO_EXTRACTABLE_TEXT",
  UNREADABLE: "MEDIA_UNREADABLE",
  REFUSED: "CONTENT_NOT_PROCESSABLE",
  UNAVAILABLE: "PROCESSING_UNAVAILABLE",
};

/**
 * The `DocumentExtractor` of audio and video (spec 0028, R3): sends the file to the media
 * understanding port with the fixed instruction and turns the timed transcript into sections that
 * carry the second they start at. It keeps no copy of the bytes (nothing is written to disk; the
 * adapter deletes what it uploaded) and maps the provider's closed failures to connection errors.
 */
export class MediaDocumentExtractor implements DocumentExtractor {
  constructor(
    private readonly kind: MediaKind,
    private readonly understanding: MediaUnderstanding,
  ) {}

  async extract(bytes: Uint8Array): Promise<ExtractedSection[]> {
    let answer: string;

    try {
      answer = await this.understanding.understand({
        kind: this.kind,
        bytes,
        mimeType: MEDIA_MIME_TYPES[this.kind],
        instruction: buildMediaInstruction(this.kind),
      });
    } catch (error) {
      throw new ConnectionProcessingError(
        error instanceof MediaUnderstandingError
          ? CODE_OF_FAILURE[error.code]
          : "PROCESSING_UNAVAILABLE",
      );
    }

    const segments = parseTimedTranscript(answer);

    if (segments.length === 0) {
      throw new ConnectionProcessingError("NO_EXTRACTABLE_TEXT");
    }

    return segments.map((segment) => ({
      text: segment.text,
      startSeconds: segment.startSeconds,
    }));
  }
}
