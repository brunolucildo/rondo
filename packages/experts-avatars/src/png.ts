import { crc32, deflateSync } from "node:zlib";
import { PNG } from "pngjs";

export type Rgb = readonly [number, number, number];

/** A decoded picture: 8-bit RGBA, row by row. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A picture whose pixels are indexes into `palette`. Index 0 is transparent when `transparent`. */
export interface IndexedImage {
  width: number;
  height: number;
  palette: readonly Rgb[];
  indices: Uint8Array;
  transparent: boolean;
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export function decodePng(bytes: Uint8Array): RgbaImage {
  const decoded = PNG.sync.read(Buffer.from(bytes));

  return { width: decoded.width, height: decoded.height, data: new Uint8Array(decoded.data) };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const tail = Buffer.alloc(4);

  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  tail.writeUInt32BE(crc32(typed), 0);

  return Buffer.concat([head, body, tail]);
}

/**
 * Writes a PNG with a palette (color type 3, 8 bits). pngjs cannot write indexed PNGs, and an
 * indexed file is what keeps a 144 px avatar a few kilobytes. Index 0 is transparent when the
 * image says so (`tRNS`).
 */
export function encodeIndexedPng(image: IndexedImage): Uint8Array {
  const { width, height, palette, indices, transparent } = image;

  if (palette.length < 1 || palette.length > 256) {
    throw new Error("The palette needs 1 to 256 colors.");
  }

  if (indices.length !== width * height) {
    throw new Error("The pixel count does not match the dimensions.");
  }

  const header = Buffer.alloc(13);

  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 3; // color type: indexed
  header[10] = 0; // compression
  header[11] = 0; // filter method
  header[12] = 0; // no interlace

  const rows = Buffer.alloc((width + 1) * height);

  for (let y = 0; y < height; y += 1) {
    rows[y * (width + 1)] = 0; // filter: none
    rows.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }

  const chunks = [
    chunk("IHDR", header),
    chunk("PLTE", Buffer.from(palette.flatMap((color) => [...color]))),
  ];

  if (transparent) {
    chunks.push(chunk("tRNS", Buffer.of(0)));
  }

  chunks.push(chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0)));

  return Buffer.concat([SIGNATURE, ...chunks]);
}

/** What the header and the palette of a PNG say, without decoding the pixels. */
export interface PngInfo {
  width: number;
  height: number;
  colorType: number;
  /** Entries in `PLTE`; 0 when the file has no palette. */
  paletteSize: number;
}

export function readPngInfo(bytes: Uint8Array): PngInfo {
  const buffer = Buffer.from(bytes);

  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(Buffer.from(SIGNATURE))) {
    throw new Error("Not a PNG file.");
  }

  let paletteSize = 0;

  for (let offset = 8; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);

    if (type === "PLTE") {
      paletteSize = length / 3;
    }

    offset += 12 + length;
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25] ?? -1,
    paletteSize,
  };
}
