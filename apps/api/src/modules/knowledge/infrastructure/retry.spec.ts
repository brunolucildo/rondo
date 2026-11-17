import { describe, expect, it, vi } from "vitest";
import { KnowledgeIndexUnavailableError } from "../domain/knowledge-errors";
import { withRetry, withTimeout } from "./retry";

const policy = { attempts: 3, backoffMs: [250, 500] };
const typed = (error: unknown): KnowledgeIndexUnavailableError =>
  error instanceof KnowledgeIndexUnavailableError
    ? error
    : new KnowledgeIndexUnavailableError("CONNECTION", true);

describe("withRetry", () => {
  it("waits longer between tries and succeeds on the third", async () => {
    const waits: number[] = [];
    const run = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce("ok");

    await expect(
      withRetry(run, typed, policy, (ms) => Promise.resolve(void waits.push(ms))),
    ).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([250, 500]);
  });

  it("gives up after the last try with the attempt count on the typed error", async () => {
    const run = vi.fn().mockRejectedValue(new Error("down"));
    const error = await withRetry(run, typed, policy, () => Promise.resolve()).catch(
      (caught: unknown) => caught,
    );

    expect(run).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(KnowledgeIndexUnavailableError);
    expect((error as KnowledgeIndexUnavailableError).attempts).toBe(3);
  });

  it("does not retry a failure that cannot be fixed by trying again", async () => {
    const run = vi
      .fn()
      .mockRejectedValue(new KnowledgeIndexUnavailableError("UNAUTHORIZED", false));
    const error = await withRetry(run, typed, policy, () => Promise.resolve()).catch(
      (caught: unknown) => caught,
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect((error as KnowledgeIndexUnavailableError).attempts).toBe(1);
  });
});

describe("withTimeout", () => {
  it("rejects with the given error when the promise is too slow", async () => {
    const never = new Promise<string>(() => undefined);

    await expect(
      withTimeout(never, 20, () => new KnowledgeIndexUnavailableError("TIMEOUT", true)),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("passes the value through when it is fast enough", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, () => new Error("late"))).resolves.toBe(7);
  });
});
