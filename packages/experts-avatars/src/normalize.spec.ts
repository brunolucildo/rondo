import { describe, expect, it } from "vitest";
import { DEFAULT_NORMALIZE, normalizeAvatar } from "./normalize.ts";
import { decodePng, readPngInfo } from "./png.ts";
import { syntheticPicture } from "./test-png.ts";

describe("normalizeAvatar", () => {
  const output = normalizeAvatar(syntheticPicture());
  const info = readPngInfo(output);
  const decoded = decodePng(output);

  it("writes a square indexed PNG within the avatar limits", () => {
    const side = DEFAULT_NORMALIZE.grid * DEFAULT_NORMALIZE.scale;

    expect(info.width).toBe(side);
    expect(info.height).toBe(side);
    expect(side).toBeGreaterThanOrEqual(96);
    expect(side).toBeLessThanOrEqual(192);
    expect(info.colorType).toBe(3);
    expect(info.paletteSize).toBeLessThanOrEqual(32);
    expect(output.byteLength).toBeLessThanOrEqual(20 * 1024);
  });

  it("limits the picture to the palette it declares", () => {
    const colors = new Set<number>();

    for (let at = 0; at < decoded.data.length; at += 4) {
      if (decoded.data[at + 3] !== 0) {
        colors.add(
          ((decoded.data[at] ?? 0) << 16) |
            ((decoded.data[at + 1] ?? 0) << 8) |
            (decoded.data[at + 2] ?? 0),
        );
      }
    }

    expect(colors.size).toBeLessThanOrEqual(DEFAULT_NORMALIZE.maxColors);
    expect(colors.size).toBeGreaterThan(1);
  });

  it("keeps a visible pixel grid: every scale x scale block is one color", () => {
    const { scale } = DEFAULT_NORMALIZE;
    const pixel = (x: number, y: number) => {
      const at = (y * decoded.width + x) * 4;

      return decoded.data.slice(at, at + 4).join(",");
    };

    for (let y = 0; y < decoded.height; y += scale) {
      for (let x = 0; x < decoded.width; x += scale) {
        const first = pixel(x, y);

        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            expect(pixel(x + dx, y + dy)).toBe(first);
          }
        }
      }
    }
  });

  it("clears the background that touches the border and keeps the subject opaque", () => {
    const alpha = (x: number, y: number) => decoded.data[(y * decoded.width + x) * 4 + 3];

    expect(alpha(0, 0)).toBe(0);
    expect(alpha(decoded.width - 1, decoded.height - 1)).toBe(0);
    expect(alpha(decoded.width / 2, decoded.height / 2)).toBe(255);
  });

  it("is deterministic", () => {
    expect(Buffer.from(normalizeAvatar(syntheticPicture())).equals(Buffer.from(output))).toBe(true);
  });

  it("rejects a picture smaller than the grid and bytes that are not a PNG", () => {
    expect(() => normalizeAvatar(syntheticPicture(20, 20))).toThrow(/smaller than/);
    expect(() => normalizeAvatar(Uint8Array.of(1, 2, 3))).toThrow();
  });
});
