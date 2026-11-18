import { describe, expect, it, vi } from "vitest";
import { MediaUnderstandingError } from "../domain/media-understanding";
import {
  type GeminiClient,
  type GeminiFile,
  type GeminiGeneration,
  GeminiMediaUnderstanding,
} from "./gemini-media-understanding";

const REQUEST = {
  kind: "video" as const,
  bytes: Buffer.from("not really video"),
  mimeType: "video/mp4",
  instruction: "Transcribe.",
};

const file = (state: GeminiFile["state"] = "ACTIVE", name = "files/abc"): GeminiFile => ({
  name,
  uri: `https://provider.test/${name}`,
  mimeType: "video/mp4",
  state,
});

const answer = (text: string | undefined, blocked = false): GeminiGeneration => ({
  text,
  blocked,
});

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`provider said ${status} and echoed the SENTINEL-file-name`);
  }
}

type Step<T> = T | Error;

/** Scripts what each call of the provider does, in order; the last step repeats. */
function scripted<T>(steps: Step<T>[]): () => Promise<T> {
  let call = 0;

  return () => {
    const step = steps[Math.min(call, steps.length - 1)] as Step<T>;

    call += 1;

    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  };
}

function setup(
  script: {
    upload?: Step<GeminiFile>[];
    get?: Step<GeminiFile>[];
    generate?: Step<GeminiGeneration>[];
    remove?: Step<undefined>[];
  } = {},
  options: ConstructorParameters<typeof GeminiMediaUnderstanding>[1] = {},
) {
  const upload = vi.fn<GeminiClient["uploadFile"]>(scripted(script.upload ?? [file()]));
  const get = vi.fn<GeminiClient["getFile"]>(scripted(script.get ?? [file()]));
  const generate = vi.fn<GeminiClient["generate"]>(
    scripted(script.generate ?? [answer("[00:01] Hello.")]),
  );
  const remove = vi.fn<GeminiClient["deleteFile"]>(scripted(script.remove ?? [undefined]));
  const client: GeminiClient = {
    uploadFile: upload,
    getFile: get,
    generate,
    deleteFile: remove,
  };
  const adapter = new GeminiMediaUnderstanding(client, {
    wait: () => Promise.resolve(),
    sweepIntervalMs: 0,
    ...options,
  });

  return { adapter, upload, get, generate, remove };
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof MediaUnderstandingError ? error.code : "other";
  }

  return "none";
}

describe("GeminiMediaUnderstanding (R3, R4, R5)", () => {
  it("uploads, asks for the transcript and deletes the file", async () => {
    const { adapter, upload, generate, remove } = setup();

    expect(await adapter.understand(REQUEST)).toBe("[00:01] Hello.");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[1]).toBe("video/mp4");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[1]).toBe("Transcribe.");
    expect(remove).toHaveBeenCalledExactlyOnceWith("files/abc");
    expect(adapter.pendingDeletionCount).toBe(0);
  });

  it("waits until the provider has processed the file", async () => {
    const { adapter, get, generate } = setup({
      upload: [file("PROCESSING")],
      get: [file("PROCESSING"), file("PROCESSING"), file("ACTIVE")],
    });

    await adapter.understand(REQUEST);

    expect(get).toHaveBeenCalledTimes(3);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("fails with UNREADABLE when the provider could not process the file, and still deletes it", async () => {
    const { adapter, generate, remove } = setup({
      upload: [file("PROCESSING")],
      get: [file("FAILED")],
    });

    expect(await codeOf(adapter.understand(REQUEST))).toBe("UNREADABLE");
    expect(generate).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("tries a second time on 429, 5xx and network failures, reusing the uploaded file", async () => {
    for (const first of [new HttpError(429), new HttpError(503), new TypeError("fetch failed")]) {
      const { adapter, upload, generate } = setup({
        generate: [first, answer("[00:02] Second time.")],
      });

      expect(await adapter.understand(REQUEST)).toBe("[00:02] Second time.");
      expect(upload).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(2);
    }
  });

  it("gives up as UNAVAILABLE after two 429 answers and deletes the file once", async () => {
    const { adapter, generate, remove } = setup({ generate: [new HttpError(429)] });

    expect(await codeOf(adapter.understand(REQUEST))).toBe("UNAVAILABLE");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("does not retry what trying again cannot fix", async () => {
    const unreadable = setup({ generate: [new HttpError(400)] });
    const keyRefused = setup({ upload: [new HttpError(403)] });

    expect(await codeOf(unreadable.adapter.understand(REQUEST))).toBe("UNREADABLE");
    expect(unreadable.generate).toHaveBeenCalledTimes(1);
    expect(await codeOf(keyRefused.adapter.understand(REQUEST))).toBe("UNAVAILABLE");
    expect(keyRefused.upload).toHaveBeenCalledTimes(1);
    // Nothing was uploaded, so there is nothing to delete.
    expect(keyRefused.remove).not.toHaveBeenCalled();
  });

  it("reports a refusal by the provider's policy and an empty answer, and deletes the file both times", async () => {
    const refused = setup({ generate: [answer(undefined, true)] });
    const silent = setup({ generate: [answer("   ")] });

    expect(await codeOf(refused.adapter.understand(REQUEST))).toBe("REFUSED");
    expect(await codeOf(silent.adapter.understand(REQUEST))).toBe("NO_CONTENT");
    expect(refused.remove).toHaveBeenCalledTimes(1);
    expect(silent.remove).toHaveBeenCalledTimes(1);
  });

  it("stops an attempt after the timeout, tries again and then fails as UNAVAILABLE with the file deleted", async () => {
    const generate = vi.fn(() => new Promise<GeminiGeneration>(() => undefined));
    const remove = vi.fn(() => Promise.resolve());
    const adapter = new GeminiMediaUnderstanding(
      {
        uploadFile: () => Promise.resolve(file()),
        getFile: () => Promise.resolve(file()),
        generate,
        deleteFile: remove,
      },
      { attemptTimeoutMs: 20, wait: () => Promise.resolve(), sweepIntervalMs: 0 },
    );

    expect(await codeOf(adapter.understand(REQUEST))).toBe("UNAVAILABLE");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("never carries the provider's message, which can echo content or names, into its error", async () => {
    const { adapter } = setup({ generate: [new HttpError(500)] });
    const error = await adapter.understand(REQUEST).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MediaUnderstandingError);
    expect((error as Error).message).toBe("Media understanding failed: UNAVAILABLE");
    expect(JSON.stringify(error)).not.toContain("SENTINEL");
  });

  it("is unavailable without a client (no key) and never calls anything", async () => {
    const adapter = new GeminiMediaUnderstanding(undefined);

    expect(adapter.isAvailable()).toBe(false);
    expect(await codeOf(adapter.understand(REQUEST))).toBe("UNAVAILABLE");
    expect(setup().adapter.isAvailable()).toBe(true);
  });
});

describe("cleanup at the provider (R4)", () => {
  it("keeps the result when the deletion fails, remembers it and repeats it in the next sweep", async () => {
    const { adapter, remove } = setup({ remove: [new HttpError(500), undefined] });

    expect(await adapter.understand(REQUEST)).toBe("[00:01] Hello.");
    expect(adapter.pendingDeletionCount).toBe(1);

    expect(await adapter.sweep()).toBe(0);
    expect(adapter.pendingDeletionCount).toBe(0);
    expect(remove).toHaveBeenNthCalledWith(2, "files/abc");
  });

  it("sweeps before the next call, so a pending deletion is repeated without a timer", async () => {
    const { adapter, remove } = setup({ remove: [new HttpError(500), undefined, undefined] });

    await adapter.understand(REQUEST);
    expect(adapter.pendingDeletionCount).toBe(1);

    await adapter.understand(REQUEST);

    expect(adapter.pendingDeletionCount).toBe(0);
    // First delete (failed), the sweep that retried it, and the delete of the second call.
    expect(remove).toHaveBeenCalledTimes(3);
  });

  it("keeps a deletion that keeps failing and forgets one the provider already expired", async () => {
    const stuck = setup({ remove: [new HttpError(500)] });
    const gone = setup({ remove: [new HttpError(404)] });

    await stuck.adapter.understand(REQUEST);
    await stuck.adapter.sweep();
    await gone.adapter.understand(REQUEST);

    expect(stuck.adapter.pendingDeletionCount).toBe(1);
    expect(gone.adapter.pendingDeletionCount).toBe(0);
  });

  it("retries the pending deletions on a timer when one is configured", async () => {
    vi.useFakeTimers();

    try {
      const { adapter, remove } = setup(
        { remove: [new HttpError(500), undefined] },
        { sweepIntervalMs: 50 },
      );

      await adapter.understand(REQUEST);
      expect(adapter.pendingDeletionCount).toBe(1);

      await vi.advanceTimersByTimeAsync(60);

      expect(adapter.pendingDeletionCount).toBe(0);
      expect(remove).toHaveBeenCalledTimes(2);
      adapter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
