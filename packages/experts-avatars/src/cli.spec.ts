import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AVATAR_CHARACTERS, findCharacter } from "./characters.ts";
import { main } from "./cli.ts";
import { type ImageClient, ImageGenerationError, type ImageRequest } from "./image-client.ts";
import { syntheticPicture } from "./test-png.ts";

let outDir: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "avatars-cli-"));
  out = [];
  err = [];
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function run(argv: string[], env: Record<string, string | undefined>, client?: ImageClient) {
  const createClient = vi.fn(
    (): ImageClient =>
      client ?? {
        generate: async () => syntheticPicture(),
      },
  );
  const code = main(argv, {
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    createClient,
    outDir,
    timeoutMs: 1_000,
  });

  return { code, createClient };
}

describe("experts:avatars", () => {
  it("prints the help and does not touch the network without a flag", async () => {
    const { code, createClient } = run([], { OPENAI_API_KEY: "test-key" });

    expect(await code).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("Usage:");
    expect(out.join("\n")).toContain("--expert");
  });

  it("fails with a clear message and no network when the key is missing", async () => {
    const { code, createClient } = run(["--expert", "head-coach"], {});

    expect(await code).toBe(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("OPENAI_API_KEY is not set");
  });

  it("treats a blank key as missing", async () => {
    const { code, createClient } = run(["--all"], { OPENAI_API_KEY: "   " });

    expect(await code).toBe(1);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects an unknown expert, conflicting flags and unknown arguments before any call", async () => {
    for (const argv of [
      ["--expert", "nobody"],
      ["--expert", "head-coach", "--all"],
      ["--expert"],
      ["--frobnicate"],
    ]) {
      const { code, createClient } = run(argv, { OPENAI_API_KEY: "test-key" });

      expect(await code).toBe(2);
      expect(createClient).not.toHaveBeenCalled();
    }
  });

  it("generates one expert and does not regenerate it without --force", async () => {
    const env = { OPENAI_API_KEY: "test-key" };
    const generate = vi.fn(async () => syntheticPicture());
    const first = run(["--expert", "head-coach"], env, { generate });

    expect(await first.code).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await readdir(outDir)).toContain("head-coach.png");

    const second = run(["--expert", "head-coach"], env, { generate });

    expect(await second.code).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(out.join("\n")).toContain("skipped");

    const third = run(["--expert", "head-coach", "--force"], env, { generate });

    expect(await third.code).toBe(0);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("uses the model and size from the environment, with gpt-image-2 and 1024x1024 as defaults", async () => {
    const generate = vi.fn(async (_request: ImageRequest) => syntheticPicture());

    await run(["--expert", "head-coach"], { OPENAI_API_KEY: "k" }, { generate }).code;
    await run(
      ["--expert", "head-coach", "--force"],
      { OPENAI_API_KEY: "k", OPENAI_IMAGE_MODEL: "other-model", OPENAI_IMAGE_SIZE: "512x512" },
      { generate },
    ).code;

    expect(generate.mock.calls[0]?.[0]).toMatchObject({ model: "gpt-image-2", size: "1024x1024" });
    expect(generate.mock.calls[1]?.[0]).toMatchObject({ model: "other-model", size: "512x512" });
  });

  it("with --all, generates the others, lists the blocked one and exits non-zero", async () => {
    const blocked = findCharacter("physiologist");
    const generate = vi.fn(async ({ prompt }: { prompt: string }) => {
      if (blocked !== undefined && prompt.includes(blocked.appearance)) {
        throw new ImageGenerationError("blocked", "Blocked by the content policy: refused");
      }

      return syntheticPicture();
    });
    const { code } = run(["--all"], { OPENAI_API_KEY: "test-key" }, { generate });

    expect(await code).toBe(1);
    expect(generate).toHaveBeenCalledTimes(AVATAR_CHARACTERS.length);

    const files = await readdir(outDir);

    expect(files).not.toContain("physiologist.png");
    expect(files.filter((file) => file.endsWith(".png"))).toHaveLength(6);
    expect(err.join("\n")).toContain("physiologist: FAILED");
    expect(err.join("\n")).toContain("blocked");
  });

  it("never prints the key", async () => {
    await writeFile(join(outDir, "head-coach.png"), "x");

    const { code } = run(["--all"], { OPENAI_API_KEY: "sk-secret-value" });

    await code;

    expect([...out, ...err].join("\n")).not.toContain("sk-secret-value");
  });
});
