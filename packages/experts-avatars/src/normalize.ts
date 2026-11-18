import { decodePng, encodeIndexedPng, type IndexedImage, type Rgb, type RgbaImage } from "./png.ts";

export interface NormalizeOptions {
  /** Logical pixels per side: the visible pixel grid. */
  grid: number;
  /** Each logical pixel becomes `scale` x `scale` real pixels (nearest neighbor). */
  scale: number;
  /** Most colors in the palette, not counting the transparent index. */
  maxColors: number;
}

export const DEFAULT_NORMALIZE: NormalizeOptions = { grid: 48, scale: 3, maxColors: 16 };

/** A grid cell: a color, or `null` for transparent. */
type Cell = Rgb | null;

interface Bucket {
  count: number;
  r: number;
  g: number;
  b: number;
}

interface Weighted {
  color: Rgb;
  count: number;
}

const ALPHA_THRESHOLD = 128;

/** Start of the `index`-th of `parts` equal slices of `side`, in pixels. */
function sliceStart(index: number, parts: number, side: number): number {
  return Math.floor((index * side) / parts);
}

/**
 * Reduces the picture to `grid` x `grid` cells over the largest centered square, so a non-square
 * answer is never stretched. Each cell takes the most common color of its block (compared in 4
 * bits per channel), so thin outlines survive better than with an average, which would blur them.
 */
function reduceToGrid(image: RgbaImage, grid: number): Cell[] {
  const side = Math.min(image.width, image.height);
  const left = Math.floor((image.width - side) / 2);
  const top = Math.floor((image.height - side) / 2);
  const cells: Cell[] = [];

  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      const x0 = sliceStart(gx, grid, side);
      const y0 = sliceStart(gy, grid, side);
      const x1 = Math.max(sliceStart(gx + 1, grid, side), x0 + 1);
      const y1 = Math.max(sliceStart(gy + 1, grid, side), y0 + 1);
      const buckets = new Map<number, Bucket>();
      let transparent = 0;
      let total = 0;

      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const at = ((top + y) * image.width + left + x) * 4;
          const r = image.data[at] ?? 0;
          const g = image.data[at + 1] ?? 0;
          const b = image.data[at + 2] ?? 0;

          total += 1;

          if ((image.data[at + 3] ?? 255) < ALPHA_THRESHOLD) {
            transparent += 1;
            continue;
          }

          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };

          bucket.count += 1;
          bucket.r += r;
          bucket.g += g;
          bucket.b += b;
          buckets.set(key, bucket);
        }
      }

      let best: Bucket | null = null;

      for (const bucket of buckets.values()) {
        if (best === null || bucket.count > best.count) {
          best = bucket;
        }
      }

      cells.push(
        best === null || transparent * 2 > total
          ? null
          : [
              Math.round(best.r / best.count),
              Math.round(best.g / best.count),
              Math.round(best.b / best.count),
            ],
      );
    }
  }

  return cells;
}

/** Median cut: repeatedly splits the box with most pixels along its widest channel. */
function medianCut(colors: readonly Weighted[], maxColors: number): Rgb[] {
  let boxes: Weighted[][] = [[...colors]];

  while (boxes.length < maxColors) {
    let target = -1;
    let targetWeight = 0;

    boxes.forEach((candidate, index) => {
      const weight = candidate.reduce((sum, item) => sum + item.count, 0);

      if (candidate.length > 1 && weight > targetWeight) {
        target = index;
        targetWeight = weight;
      }
    });

    const box = boxes[target];

    if (box === undefined) {
      break;
    }

    const ranges = [0, 1, 2].map((channel) => {
      const values = box.map((item) => item.color[channel] ?? 0);

      return Math.max(...values) - Math.min(...values);
    });
    const channel = ranges.indexOf(Math.max(...ranges));
    const sorted = [...box].sort((a, b) => (a.color[channel] ?? 0) - (b.color[channel] ?? 0));
    let seen = 0;
    let cut = 1;

    for (let i = 0; i < sorted.length - 1; i += 1) {
      seen += sorted[i]?.count ?? 0;
      cut = i + 1;

      if (seen * 2 >= targetWeight) {
        break;
      }
    }

    boxes = boxes.filter((_, index) => index !== target);
    boxes.push(sorted.slice(0, cut), sorted.slice(cut));
  }

  return boxes.map((box) => {
    const weight = box.reduce((sum, item) => sum + item.count, 0);
    const mean = (channel: number) =>
      Math.round(
        box.reduce((sum, item) => sum + (item.color[channel] ?? 0) * item.count, 0) / weight,
      );

    return [mean(0), mean(1), mean(2)] as const;
  });
}

function nearest(palette: readonly Rgb[], color: Rgb): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  palette.forEach((candidate, index) => {
    const distance =
      (candidate[0] - color[0]) ** 2 +
      (candidate[1] - color[1]) ** 2 +
      (candidate[2] - color[2]) ** 2;

    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });

  return best;
}

/**
 * Turns the color the picture ends on at its borders into transparency (`-1`), so one file works
 * on the light and the dark theme. Only the pixels connected to the border are cleared: the same
 * color inside the character (an eye, a shirt) stays. It does nothing when the border is not
 * mostly one color, as in a drawing that fills the frame.
 */
function clearBackground(indices: Int16Array, grid: number): void {
  const border: number[] = [];
  const counts = new Map<number, number>();

  for (let i = 0; i < grid; i += 1) {
    border.push(i, (grid - 1) * grid + i, i * grid, i * grid + grid - 1);
  }

  for (const at of border) {
    const value = indices[at] ?? -1;

    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  let background = -1;
  let backgroundCount = 0;

  for (const [value, count] of counts) {
    if (value >= 0 && count > backgroundCount) {
      background = value;
      backgroundCount = count;
    }
  }

  if (background < 0 || backgroundCount * 2 < border.length) {
    return;
  }

  const stack = border.filter((at) => indices[at] === background);

  while (stack.length > 0) {
    const at = stack.pop();

    if (at === undefined || indices[at] !== background) {
      continue;
    }

    indices[at] = -1;

    const x = at % grid;
    const y = Math.floor(at / grid);

    if (x > 0) stack.push(at - 1);
    if (x < grid - 1) stack.push(at + 1);
    if (y > 0) stack.push(at - grid);
    if (y < grid - 1) stack.push(at + grid);
  }
}

/** Builds the indexed, upscaled picture from a decoded one. */
export function toPixelArt(
  image: RgbaImage,
  options: NormalizeOptions = DEFAULT_NORMALIZE,
): IndexedImage {
  const { grid, scale, maxColors } = options;

  if (image.width < grid || image.height < grid) {
    throw new Error(
      `The picture (${image.width}x${image.height}) is smaller than the ${grid} px grid.`,
    );
  }

  const cells = reduceToGrid(image, grid);
  const counts = new Map<string, Weighted>();

  for (const cell of cells) {
    if (cell !== null) {
      const key = cell.join(",");
      const entry = counts.get(key) ?? { color: cell, count: 0 };

      entry.count += 1;
      counts.set(key, entry);
    }
  }

  if (counts.size === 0) {
    throw new Error("The picture has no opaque pixel.");
  }

  const palette = medianCut([...counts.values()], maxColors);
  const indices = Int16Array.from(cells, (cell) => (cell === null ? -1 : nearest(palette, cell)));

  clearBackground(indices, grid);

  const transparent = indices.includes(-1);
  const offset = transparent ? 1 : 0;
  const size = grid * scale;
  const output = new Uint8Array(size * size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = indices[Math.floor(y / scale) * grid + Math.floor(x / scale)] ?? -1;

      output[y * size + x] = index < 0 ? 0 : index + offset;
    }
  }

  return {
    width: size,
    height: size,
    palette: transparent ? [[0, 0, 0] as const, ...palette] : palette,
    indices: output,
    transparent,
  };
}

/** PNG bytes in, 8-bit-style indexed PNG bytes out. */
export function normalizeAvatar(
  bytes: Uint8Array,
  options: NormalizeOptions = DEFAULT_NORMALIZE,
): Uint8Array {
  return encodeIndexedPng(toPixelArt(decodePng(bytes), options));
}
