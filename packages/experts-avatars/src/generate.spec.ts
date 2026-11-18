import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AvatarCharacter, buildPrompt, findCharacter } from "./characters.ts";
import { generateAvatars, MANIFEST_FILE, promptHash } from "./generate.ts";
import { type ImageClient, type ImageRequest, ImageGenerationError } from "./image-client.ts";
import { readPngInfo } from "./png.ts";
import { syntheticPicture } from "./test-png.ts";

class FakeClient implements ImageClient {
  readonly calls: ImageRequest[] = [];
  readonly failures = new Map<string, ImageGenerationError[]>();
  hang = new Set<string>();

  constructor(private readonly picture: Uint8Array = syntheticPicture()) {}

  failWith(promptPart: string, ...errors: ImageGenerationError[]) {
    this.failures.set(promptPart, errors);
  }

  async generate(request: ImageRequest): Promise<Uint8Array> {
    this.calls.push(request);

    for (const [part, errors] of this.failures) {
      if (request.prompt.includes(part)) {
        const next = errors.shift();

        if (next !== undefined) {
          throw next;
        }
      }
    }

    for (const part of this.hang) {
      if (request.prompt.includes(part)) {
        await new Promise((_, reject) => {
          const fail = () => reject(new ImageGenerationError("timeout", "timed out", true));

          // Under load the abort can fire before this listener exists: an already aborted signal
          // would never emit again and the test would hang.
          if (request.signal.aborted) {
            fail();
            return;
          }

          request.signal.addEventListener("abort", fail, { once: true });
        });
      }
    }

    return this.picture;
  }
}

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "avatars-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

const base = () => ({ model: "gpt-image-2", size: "1024x1024", force: false });
function sheet(id: string): AvatarCharacter {
  const found = findCharacter(id);

  if (found === undefined) {
    throw new Error(`No sheet for ${id}`);
  }

  return found;
}

const headCoach = sheet("head-coach");
const analyst = sheet("performance-analyst");
const lawyer = sheet("sports-lawyer");

describe("generateAvatars", () => {
  it("generates one normalized PNG per expert and writes the manifest", async () => {
    const client = new FakeClient();
    const now = () => new Date("2026-11-17T12:00:00.000Z");
    const outcomes = await generateAvatars({
      ...base(),
      characters: [headCoach, analyst],
      client,
      outDir,
      now,
    });

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["generated", "generated"]);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]).toMatchObject({ model: "gpt-image-2", size: "1024x1024" });

    const info = readPngInfo(await readFile(join(outDir, "head-coach.png")));

    expect(info).toMatchObject({ width: 144, height: 144, colorType: 3 });

    const manifest = JSON.parse(await readFile(join(outDir, MANIFEST_FILE), "utf8"));

    expect(manifest.avatars["head-coach"]).toEqual({
      file: "head-coach.png",
      model: "gpt-image-2",
      size: "1024x1024",
      generatedAt: "2026-11-17T12:00:00.000Z",
      promptHash: promptHash(buildPrompt(headCoach)),
    });
    expect(Object.keys(manifest.avatars)).toEqual(["head-coach", "performance-analyst"]);
  });

  it("skips an existing file without calling the API, unless forced", async () => {
    await writeFile(join(outDir, "head-coach.png"), "old");

    const client = new FakeClient();
    const skipped = await generateAvatars({
      ...base(),
      characters: [headCoach],
      client,
      outDir,
    });

    expect(skipped[0]?.status).toBe("skipped");
    expect(client.calls).toHaveLength(0);
    expect((await readFile(join(outDir, "head-coach.png"))).toString()).toBe("old");

    const forced = await generateAvatars({
      ...base(),
      force: true,
      characters: [headCoach],
      client,
      outDir,
    });

    expect(forced[0]?.status).toBe("generated");
    expect(client.calls).toHaveLength(1);
  });

  it("goes on after a blocked expert and leaves no file for it", async () => {
    const client = new FakeClient();

    client.failWith(
      analyst.appearance,
      new ImageGenerationError("blocked", "Blocked by the content policy: refused"),
    );

    const outcomes = await generateAvatars({
      ...base(),
      characters: [headCoach, analyst, lawyer],
      client,
      outDir,
    });

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["generated", "failed", "generated"]);
    expect(outcomes[1]).toMatchObject({
      id: "performance-analyst",
      reason: expect.stringContaining("blocked"),
    });
    expect(client.calls).toHaveLength(3);
    expect((await readdir(outDir)).sort()).toEqual([
      "head-coach.png",
      MANIFEST_FILE,
      "sports-lawyer.png",
    ]);
  });

  it("tries once more after a retryable error, and only once", async () => {
    const client = new FakeClient();

    client.failWith(headCoach.appearance, new ImageGenerationError("api", "rate limited", true));

    const recovered = await generateAvatars({ ...base(), characters: [headCoach], client, outDir });

    expect(recovered[0]?.status).toBe("generated");
    expect(client.calls).toHaveLength(2);

    const stubborn = new FakeClient();

    stubborn.failWith(
      analyst.appearance,
      new ImageGenerationError("api", "down", true),
      new ImageGenerationError("api", "still down", true),
      new ImageGenerationError("api", "never reached", true),
    );

    const failed = await generateAvatars({
      ...base(),
      characters: [analyst],
      client: stubborn,
      outDir,
    });

    expect(failed[0]?.status).toBe("failed");
    expect(stubborn.calls).toHaveLength(2);
  });

  it("does not retry a blocked or non-retryable error", async () => {
    const client = new FakeClient();

    client.failWith(lawyer.appearance, new ImageGenerationError("api", "bad request", false));

    await generateAvatars({ ...base(), characters: [lawyer], client, outDir });

    expect(client.calls).toHaveLength(1);
  });

  it("gives up on a timeout (one new try) and records it", async () => {
    const client = new FakeClient();

    client.hang.add(headCoach.appearance);

    const outcomes = await generateAvatars({
      ...base(),
      characters: [headCoach, analyst],
      client,
      outDir,
      timeoutMs: 20,
    });

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed", "generated"]);
    expect(client.calls.filter((call) => call.prompt.includes(headCoach.appearance))).toHaveLength(
      2,
    );
    expect(await readdir(outDir)).not.toContain("head-coach.png");
  });

  it("writes nothing when the answer is not a usable picture", async () => {
    const outcomes = await generateAvatars({
      ...base(),
      characters: [headCoach],
      client: new FakeClient(Uint8Array.of(1, 2, 3)),
      outDir,
    });

    expect(outcomes[0]?.status).toBe("failed");
    expect(await readdir(outDir)).toEqual([]);
  });

  it("stops without a partial file when interrupted", async () => {
    const controller = new AbortController();
    const client = new FakeClient();

    client.hang.add(headCoach.appearance);
    setTimeout(() => controller.abort(), 10);

    const outcomes = await generateAvatars({
      ...base(),
      characters: [headCoach, analyst],
      client,
      outDir,
      signal: controller.signal,
    });

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed", "failed"]);
    expect(await readdir(outDir)).toEqual([]);
  });

  it("creates the folder when it does not exist", async () => {
    const nested = join(outDir, "a", "b");

    await mkdir(join(outDir, "a"));
    await generateAvatars({
      ...base(),
      characters: [headCoach],
      client: new FakeClient(),
      outDir: nested,
    });

    expect(await readdir(nested)).toContain("head-coach.png");
  });
});
