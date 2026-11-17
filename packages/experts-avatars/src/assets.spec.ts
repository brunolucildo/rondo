import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AVATAR_CHARACTERS } from "./characters.ts";
import { DEFAULT_OUT_DIR } from "./cli.ts";
import { MANIFEST_FILE } from "./generate.ts";
import { readPngInfo } from "./png.ts";

const MAX_FILE_BYTES = 20 * 1024;
const MAX_TOTAL_BYTES = 150 * 1024;
const MIN_SIDE = 96;
const MAX_SIDE = 192;
const MAX_COLORS = 32;

const files = existsSync(DEFAULT_OUT_DIR)
  ? readdirSync(DEFAULT_OUT_DIR).filter((file) => file.endsWith(".png"))
  : [];
const ids = AVATAR_CHARACTERS.map((character) => character.id);

describe("avatar files in the app assets", () => {
  it("are named after an expert id", () => {
    for (const file of files) {
      expect(ids).toContain(file.replace(/\.png$/, ""));
    }
  });

  for (const file of files) {
    it(`${file} is a square indexed PNG of 96 to 192 px, up to 32 colors and 20 KB`, () => {
      const bytes = readFileSync(join(DEFAULT_OUT_DIR, file));
      const info = readPngInfo(bytes);

      expect(info.width).toBe(info.height);
      expect(info.width).toBeGreaterThanOrEqual(MIN_SIDE);
      expect(info.width).toBeLessThanOrEqual(MAX_SIDE);
      expect(info.colorType).toBe(3);
      expect(info.paletteSize).toBeLessThanOrEqual(MAX_COLORS);
      expect(bytes.byteLength).toBeLessThanOrEqual(MAX_FILE_BYTES);
    });
  }

  it("weigh less than 150 KB together", () => {
    const total = files.reduce((sum, file) => sum + statSync(join(DEFAULT_OUT_DIR, file)).size, 0);

    expect(total).toBeLessThan(MAX_TOTAL_BYTES);
  });

  it("have a manifest entry (model, date, prompt hash) each, when a manifest exists", () => {
    const path = join(DEFAULT_OUT_DIR, MANIFEST_FILE);

    if (!existsSync(path)) {
      expect(files).toEqual([]);

      return;
    }

    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      avatars: Record<string, { model: string; generatedAt: string; promptHash: string }>;
    };

    for (const file of files) {
      const entry = manifest.avatars[file.replace(/\.png$/, "")];

      expect(entry?.model).toBeTruthy();
      expect(entry?.generatedAt).toBeTruthy();
      expect(entry?.promptHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // The seven pictures come from a manual run with a real key (`bun run experts:avatars`). Until
  // they are generated and approved, completeness is opt-in: set REQUIRE_ALL_AVATARS=1.
  it.runIf(process.env.REQUIRE_ALL_AVATARS === "1")("exist for all seven experts", () => {
    expect(files.map((file) => file.replace(/\.png$/, "")).sort()).toEqual([...ids].sort());
  });
});
