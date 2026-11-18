import { crc32, deflateSync } from "node:zlib";

/**
 * Builds tiny JPEG and PNG files for tests, so no binary fixture or image library is needed. Only
 * the header is meant to be real (signature and pixel size): the vision model is always a fake.
 * `note` is appended as plain text inside the file, so two images differ and the scripted vision
 * model can read its instruction from the bytes (see `ScriptedImageDescriber`).
 */
export interface FixtureImageOptions {
  width?: number;
  height?: number;
  note?: string;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);

  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");

  const crc = Buffer.alloc(4);

  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);

  return Buffer.concat([head, data, crc]);
}

export function buildPng({ width = 8, height = 8, note = "" }: FixtureImageOptions = {}): Buffer {
  const ihdr = Buffer.alloc(13);

  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  // 8 bits per channel, RGB, deflate, no filter method, no interlace.
  ihdr.set([8, 2, 0, 0, 0], 8);

  // Pixels only for small images: a large declared size is just a header to be read.
  const pixels =
    width * height <= 64 * 64
      ? deflateSync(Buffer.alloc((width * 3 + 1) * height))
      : Buffer.alloc(0);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", pixels),
    pngChunk("IEND", Buffer.alloc(0)),
    Buffer.from(note, "latin1"),
  ]);
}

export function buildJpeg({ width = 8, height = 8, note = "" }: FixtureImageOptions = {}): Buffer {
  const comment = Buffer.from(`fixture ${note}`, "latin1");
  const commentSegment = Buffer.concat([
    Buffer.from([0xff, 0xfe, (comment.length + 2) >> 8, (comment.length + 2) & 0xff]),
    comment,
  ]);
  const frame = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);
  const scan = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00]);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    // APP0 JFIF, as cameras and editors write it, before the frame.
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]),
    Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    commentSegment,
    frame,
    scan,
    Buffer.from([0xff, 0xd9]),
  ]);
}
