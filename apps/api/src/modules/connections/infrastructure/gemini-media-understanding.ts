import { MEDIA_ATTEMPT_TIMEOUT_MS, MEDIA_MAX_ATTEMPTS } from "../domain/connection-rules";
import {
  type MediaUnderstanding,
  MediaUnderstandingError,
  type MediaUnderstandingFailure,
  type MediaUnderstandingRequest,
} from "../domain/media-understanding";
import { recordDependencyCall } from "../../../observability/agent-telemetry";
import { recordMediaCleanup } from "../../../observability/connection-telemetry";
import type { KnowledgeFailureReason } from "../../../observability/knowledge-telemetry";

/**
 * Model of the Gemini family that understands audio and video (`generateContent`, not the
 * video-generation models). Read from the documentation in 2026-11; configurable by
 * `GEMINI_UNDERSTANDING_MODEL` because model ids and prices change.
 */
export const DEFAULT_UNDERSTANDING_MODEL = "gemini-3.6-flash";

/** A file at the provider. The name is the provider's identifier: never logged. */
export interface GeminiFile {
  name: string;
  uri: string;
  mimeType: string;
  state: "PROCESSING" | "ACTIVE" | "FAILED";
}

export interface GeminiGeneration {
  /** The text of the answer, when there is one. */
  text: string | undefined;
  /** The prompt or the answer was blocked by the provider's policy. */
  blocked: boolean;
}

/**
 * The part of the Gemini API this adapter uses (Files API and `generateContent`). The real
 * implementation wraps `@google/genai`; tests pass a fake that scripts each call. Errors carry the
 * HTTP status in `status` when the provider answered.
 */
export interface GeminiClient {
  uploadFile(bytes: Uint8Array, mimeType: string, signal: AbortSignal): Promise<GeminiFile>;
  getFile(name: string, signal: AbortSignal): Promise<GeminiFile>;
  generate(file: GeminiFile, instruction: string, signal: AbortSignal): Promise<GeminiGeneration>;
  deleteFile(name: string): Promise<void>;
}

export interface GeminiMediaOptions {
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  /** Wait between two attempts. */
  backoffMs?: number;
  /** Wait between two checks of a file that is still being processed by the provider. */
  pollIntervalMs?: number;
  /** Wait before a sweep retries the deletions that failed; `0` turns the timer off (tests). */
  sweepIntervalMs?: number;
  wait?: (ms: number) => Promise<void>;
}

class AttemptTimeoutError extends Error {
  constructor() {
    super("Attempt timed out.");
    this.name = "AttemptTimeoutError";
  }
}

const defaultWait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const { status } = error as { status: unknown };

    return typeof status === "number" ? status : undefined;
  }

  return undefined;
}

interface Classification {
  code: MediaUnderstandingFailure;
  /** Trying again can work (the cause was not the file or the key). */
  retryable: boolean;
}

/**
 * Sorts what went wrong without keeping the provider's message (it can echo content or ids):
 * 429, 5xx, timeouts and network failures are retried; a 400 means the provider cannot read the
 * file; a refused key or a missing model is unavailability that retrying does not fix.
 */
function classify(error: unknown): Classification {
  if (error instanceof MediaUnderstandingError) {
    return { code: error.code, retryable: false };
  }

  if (error instanceof AttemptTimeoutError) {
    return { code: "UNAVAILABLE", retryable: true };
  }

  const status = statusOf(error);

  if (status === undefined || status === 408 || status === 429 || status >= 500) {
    return { code: "UNAVAILABLE", retryable: true };
  }

  if (status === 400 || status === 415 || status === 422) {
    return { code: "UNREADABLE", retryable: false };
  }

  return { code: "UNAVAILABLE", retryable: false };
}

/**
 * The closed `reason` of a failed call to Gemini for the `expert.dependency.calls` series (spec
 * 0029): from the HTTP status or the kind of failure, never from the provider's message.
 */
function reasonOf(error: unknown): KnowledgeFailureReason {
  if (error instanceof AttemptTimeoutError) {
    return "timeout";
  }

  if (error instanceof MediaUnderstandingError) {
    return error.code === "UNAVAILABLE" ? "provider_error" : "rejected";
  }

  const status = statusOf(error);

  if (status === undefined) {
    return "connection";
  }

  if (status === 429) {
    return "rate_limited";
  }

  if (status >= 500) {
    return "server_error";
  }

  return status === 401 || status === 403 ? "unauthorized" : "rejected";
}

/** One attempt as a call to the `gemini` dependency; an answer with no content is still an answer. */
function recordAttempt(startedAt: number, error?: unknown): void {
  const seconds = (performance.now() - startedAt) / 1000;

  if (
    error === undefined ||
    (error instanceof MediaUnderstandingError && error.code === "NO_CONTENT")
  ) {
    recordDependencyCall("gemini", "success", "none", seconds);
  } else {
    recordDependencyCall("gemini", "failure", reasonOf(error), seconds);
  }
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new AttemptTimeoutError());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AttemptTimeoutError());

    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("Provider call failed."));
      },
    );
  });
}

/**
 * `MediaUnderstanding` over the Gemini API (spec 0028, R3 to R5). One call is: upload the bytes to
 * the Files API (from memory, never from disk), wait until the file is `ACTIVE`, ask the model for
 * the timed transcript and delete the file. An attempt lasts at most 10 minutes; a 429, a 5xx, a
 * timeout or a network failure gets a second attempt (the uploaded file is reused). The deletion
 * runs in `finally`, so every outcome (success, failure, timeout) leaves nothing at the provider.
 * A deletion that fails is remembered in memory and retried by the next sweep (before the next
 * call and on a timer); the provider also expires files by itself. Without a client (no key) the
 * adapter is unavailable.
 *
 * Nothing here logs or puts in an error the name, the content, a transcript or the provider's file
 * name: the failures are a closed set.
 */
export class GeminiMediaUnderstanding implements MediaUnderstanding {
  private readonly pendingDeletions = new Set<string>();
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly attemptTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly pollIntervalMs: number;
  private readonly sweepIntervalMs: number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(
    private readonly client: GeminiClient | undefined,
    options: GeminiMediaOptions = {},
  ) {
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? MEDIA_ATTEMPT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? MEDIA_MAX_ATTEMPTS;
    this.backoffMs = options.backoffMs ?? 2000;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    this.wait = options.wait ?? defaultWait;
  }

  isAvailable(): boolean {
    return this.client !== undefined;
  }

  /** How many deletions at the provider are waiting for the next sweep. */
  get pendingDeletionCount(): number {
    return this.pendingDeletions.size;
  }

  async understand(request: MediaUnderstandingRequest): Promise<string> {
    const { client } = this;

    if (client === undefined) {
      throw new MediaUnderstandingError("UNAVAILABLE");
    }

    await this.sweep();

    let uploaded: GeminiFile | undefined;

    try {
      for (let attempt = 1; ; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.attemptTimeoutMs);
        const startedAt = performance.now();

        try {
          uploaded ??= await raceAbort(
            client.uploadFile(request.bytes, request.mimeType, controller.signal),
            controller.signal,
          );

          const ready = await this.untilActive(client, uploaded, controller.signal);

          const answer = this.readAnswer(
            await raceAbort(
              client.generate(ready, request.instruction, controller.signal),
              controller.signal,
            ),
          );

          recordAttempt(startedAt);

          return answer;
        } catch (error) {
          recordAttempt(startedAt, error);

          const { code, retryable } = classify(error);

          if (!retryable || attempt >= this.maxAttempts) {
            throw new MediaUnderstandingError(code);
          }

          await this.wait(this.backoffMs);
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      if (uploaded !== undefined) {
        await this.delete(client, uploaded.name);
      }
    }
  }

  /** Retries the deletions that failed. Never throws. Returns how many are still pending. */
  async sweep(): Promise<number> {
    const { client } = this;

    if (client === undefined) {
      return 0;
    }

    for (const name of this.pendingDeletions) {
      try {
        await client.deleteFile(name);
        this.pendingDeletions.delete(name);
        recordMediaCleanup("retried", this.pendingDeletions.size);
      } catch (error) {
        // Already gone (the provider expires files by itself): nothing left to delete.
        if (statusOf(error) === 404) {
          this.pendingDeletions.delete(name);
        }
      }
    }

    return this.pendingDeletions.size;
  }

  /** Stops the sweep timer (shutdown). */
  dispose(): void {
    if (this.sweepTimer !== undefined) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private async untilActive(
    client: GeminiClient,
    file: GeminiFile,
    signal: AbortSignal,
  ): Promise<GeminiFile> {
    let current = file;

    while (current.state === "PROCESSING") {
      await raceAbort(this.wait(this.pollIntervalMs), signal);
      current = await raceAbort(client.getFile(file.name, signal), signal);
    }

    if (current.state === "FAILED") {
      throw new MediaUnderstandingError("UNREADABLE");
    }

    return current;
  }

  private readAnswer(generation: GeminiGeneration): string {
    if (generation.blocked) {
      throw new MediaUnderstandingError("REFUSED");
    }

    const text = generation.text?.trim() ?? "";

    if (text === "") {
      throw new MediaUnderstandingError("NO_CONTENT");
    }

    return text;
  }

  private async delete(client: GeminiClient, name: string): Promise<void> {
    try {
      await client.deleteFile(name);
      recordMediaCleanup("deleted", this.pendingDeletions.size);
    } catch (error) {
      if (statusOf(error) === 404) {
        return;
      }

      this.pendingDeletions.add(name);
      recordMediaCleanup("pending", this.pendingDeletions.size);
      this.scheduleSweep();
    }
  }

  private scheduleSweep(): void {
    if (this.sweepIntervalMs <= 0 || this.sweepTimer !== undefined) {
      return;
    }

    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      void this.sweep().then((pending) => {
        if (pending > 0) {
          this.scheduleSweep();
        }
      });
    }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }
}
