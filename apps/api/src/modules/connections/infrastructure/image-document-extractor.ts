import { ConnectionProcessingError, VisionRefusedError } from "../domain/connection-errors";
import type {
  DocumentExtractor,
  ExtractedSection,
  ImageDescriber,
} from "../domain/connection-ports";
import {
  MAX_IMAGE_TEXT_CHARS,
  VISION_ATTEMPT_TIMEOUT_MS,
  VISION_MAX_ATTEMPTS,
} from "../domain/connection-rules";
import { detectImageMimeType } from "../domain/image-format";
import { IMAGE_NO_CONTENT_MARKER, VISION_INSTRUCTION } from "../domain/vision-instruction";

export interface ImageDocumentExtractorOptions {
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  maxChars?: number;
  /** Pause between two attempts; replaced in tests. */
  wait?: (ms: number) => Promise<void>;
}

const RETRY_DELAY_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class AttemptTimeoutError extends Error {
  constructor() {
    super("The vision call timed out.");
    this.name = "AttemptTimeoutError";
  }
}

/** True for an answer with nothing to index: empty, or the marker the instruction asks for. */
function hasNoContent(text: string): boolean {
  const bare = text.replace(/[^\p{L}\p{N}_]/gu, "").toUpperCase();

  return bare === "" || bare === IMAGE_NO_CONTENT_MARKER;
}

/** Cuts to `max` characters without leaving half of a surrogate pair at the end. */
function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);

  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Turns an image into text with a vision model (spec 0026): one `DocumentExtractor` for JPEG and
 * PNG. It asks the `ImageDescriber` with the fixed instruction, gives each attempt 30 seconds and
 * at most 2 attempts (only for an unavailable model or a timeout), cuts the answer to 4,000
 * characters and maps the failures to the closed codes: nothing to read is `NO_EXTRACTABLE_TEXT`, a
 * refusal is `CONTENT_NOT_PROCESSABLE`, anything else is `PROCESSING_UNAVAILABLE`.
 *
 * The answer is data: it becomes one section of text (no page) and goes to the same chunking,
 * embeddings and index as any document. The bytes are never kept and nothing is logged here.
 */
export class ImageDocumentExtractor implements DocumentExtractor {
  private readonly attemptTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxChars: number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(
    private readonly describer: ImageDescriber,
    options: ImageDocumentExtractorOptions = {},
  ) {
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? VISION_ATTEMPT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? VISION_MAX_ATTEMPTS;
    this.maxChars = options.maxChars ?? MAX_IMAGE_TEXT_CHARS;
    this.wait = options.wait ?? sleep;
  }

  async extract(bytes: Uint8Array): Promise<ExtractedSection[]> {
    const mimeType = detectImageMimeType(bytes);

    if (mimeType === null) {
      throw new ConnectionProcessingError("CONTENT_NOT_PROCESSABLE");
    }

    const answer = await this.describeWithRetries({
      bytes,
      mimeType,
      instruction: VISION_INSTRUCTION,
    });
    const text = answer.replaceAll("\u0000", "").trim();

    if (hasNoContent(text)) {
      throw new ConnectionProcessingError("NO_EXTRACTABLE_TEXT");
    }

    return [{ text: truncate(text, this.maxChars) }];
  }

  private async describeWithRetries(
    image: Parameters<ImageDescriber["describe"]>[0],
  ): Promise<string> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.describeOnce(image);
      } catch (error) {
        if (error instanceof ConnectionProcessingError) {
          throw error;
        }

        if (error instanceof VisionRefusedError) {
          throw new ConnectionProcessingError("CONTENT_NOT_PROCESSABLE");
        }

        // An unavailable model, a timeout or anything unexpected: worth one more try.
        if (attempt < this.maxAttempts) {
          await this.wait(RETRY_DELAY_MS);
        }
      }
    }

    throw new ConnectionProcessingError("PROCESSING_UNAVAILABLE");
  }

  private async describeOnce(image: Parameters<ImageDescriber["describe"]>[0]): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AttemptTimeoutError());
      }, this.attemptTimeoutMs);
    });
    const call = this.describer.describe(image, controller.signal);

    // A call that loses the race still settles later: its rejection must not go unhandled.
    call.catch(() => undefined);

    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
