import {
  MediaUnderstandingError,
  type MediaUnderstanding,
  type MediaUnderstandingFailure,
  type MediaUnderstandingRequest,
} from "../domain/media-understanding";

/**
 * The scripts a test file carries inside its own bytes (a tag of the MP3, a `free` box of the MP4;
 * see `testing/media-fixtures.ts`), so the fake needs no side channel and the E2E can pick the
 * outcome by building the file: `RONDO_FAKE_TRANSCRIPT=<text>` answers that text (`\n` written as
 * two characters separates lines), `RONDO_FAKE_FAIL=<CODE>` fails with that closed code. Anything
 * else gets the default transcript. The text ends at the first NUL byte.
 */
export const FAKE_TRANSCRIPT_MARKER = "RONDO_FAKE_TRANSCRIPT=";
export const FAKE_FAIL_MARKER = "RONDO_FAKE_FAIL=";

export const FAKE_DEFAULT_AUDIO_TRANSCRIPT = "[00:05] This is a scripted transcript of the audio.";
export const FAKE_DEFAULT_VIDEO_TRANSCRIPT = [
  "[00:03] This is a scripted transcript of the video.",
  "[00:10] SCENE: a scripted scene shows a pitch with a scoreboard.",
].join("\n");

const FAILURES: ReadonlySet<string> = new Set<MediaUnderstandingFailure>([
  "NO_CONTENT",
  "UNREADABLE",
  "REFUSED",
  "UNAVAILABLE",
]);

function markerValue(bytes: Uint8Array, marker: string): string | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = buffer.indexOf(marker, 0, "utf8");

  if (at < 0) {
    return undefined;
  }

  const start = at + marker.length;
  const end = buffer.indexOf(0, start);

  return buffer.subarray(start, end < 0 ? buffer.byteLength : end).toString("utf8");
}

/** What the fake saw: tests read it to prove what was (not) sent to the provider. */
export interface FakeMediaCall {
  kind: MediaUnderstandingRequest["kind"];
  mimeType: string;
  byteLength: number;
  instruction: string;
}

/**
 * `MediaUnderstanding` that never touches the network, selected by `NODE_ENV=test` (like the fake
 * embeddings). It records every call, can be held and released by a test (to watch a job in the
 * `processing` state) and mimics the provider's cleanup: `uploads` and `deletions` match after
 * every call, success or failure.
 */
export class FakeMediaUnderstanding implements MediaUnderstanding {
  readonly calls: FakeMediaCall[] = [];
  uploads = 0;
  deletions = 0;
  available = true;
  /** While set, `understand` waits for it before answering. */
  hold: Promise<void> | undefined;

  isAvailable(): boolean {
    return this.available;
  }

  async understand(request: MediaUnderstandingRequest): Promise<string> {
    this.calls.push({
      kind: request.kind,
      mimeType: request.mimeType,
      byteLength: request.bytes.byteLength,
      instruction: request.instruction,
    });
    this.uploads += 1;

    try {
      await this.hold;

      const failure = markerValue(request.bytes, FAKE_FAIL_MARKER);

      if (failure !== undefined && FAILURES.has(failure)) {
        throw new MediaUnderstandingError(failure as MediaUnderstandingFailure);
      }

      const script = markerValue(request.bytes, FAKE_TRANSCRIPT_MARKER);

      if (script !== undefined) {
        return script.replaceAll("\\n", "\n");
      }

      return request.kind === "video"
        ? FAKE_DEFAULT_VIDEO_TRANSCRIPT
        : FAKE_DEFAULT_AUDIO_TRANSCRIPT;
    } finally {
      this.deletions += 1;
    }
  }
}
