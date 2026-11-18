import {
  FAKE_FAIL_MARKER,
  FAKE_TRANSCRIPT_MARKER,
} from "../infrastructure/fake-media-understanding";

/**
 * Tiny valid MP3 and MP4 files for tests (no real audio or video: only the headers the API reads).
 * `script` makes the fake media provider answer that transcript (`\n` between lines) and `fail`
 * makes it fail with a closed code; `salt` changes the bytes (so the content hash) without
 * changing anything else.
 */
export interface MediaFixtureOptions {
  script?: string;
  fail?: "NO_CONTENT" | "UNREADABLE" | "REFUSED" | "UNAVAILABLE";
  salt?: string;
}

function marker({ script, fail, salt }: MediaFixtureOptions): Buffer {
  const parts: string[] = [];

  if (script !== undefined) {
    parts.push(`${FAKE_TRANSCRIPT_MARKER}${script.replaceAll("\n", "\\n")}\u0000`);
  }

  if (fail !== undefined) {
    parts.push(`${FAKE_FAIL_MARKER}${fail}\u0000`);
  }

  if (salt !== undefined) {
    parts.push(`SALT=${salt}\u0000`);
  }

  return Buffer.from(parts.join(""), "utf8");
}

const syncsafe = (value: number): Buffer =>
  Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);

export interface Mp3Options extends MediaFixtureOptions {
  /** Constant bitrate frames of 128 kbps / 44.1 kHz (417 bytes, 26 ms each). Default 40. */
  frames?: number;
  /** A Xing header that declares this many frames (the length then comes from it). */
  declaredFrames?: number;
  /** Frames of another bitrate after the first, and no Xing header: a VBR file with no header. */
  variableBitrate?: boolean;
  /** An ID3v1 tag of 128 bytes at the end. */
  id3v1?: boolean;
  /** Skip the ID3v2 tag (the file then starts with the frame sync). */
  noId3?: boolean;
}

const FRAME_128_BYTES = 417;
const FRAME_160_BYTES = 522;

function mp3Frame(headerThird: number, bytes: number): Buffer {
  const frame = Buffer.alloc(bytes);

  frame.set([0xff, 0xfb, headerThird, 0x00]);

  return frame;
}

/** An MP3 of `frames * 26 ms`, or whatever `declaredFrames` says. */
export function buildMp3(options: Mp3Options = {}): Buffer {
  const frames = options.frames ?? 40;
  const body = marker(options);
  const tag =
    options.noId3 === true || body.byteLength === 0
      ? Buffer.alloc(0)
      : Buffer.concat([
          Buffer.from("ID3"),
          Buffer.from([3, 0, 0]),
          syncsafe(body.byteLength),
          body,
        ]);
  const audio: Buffer[] = [];

  for (let number = 0; number < frames; number += 1) {
    if (number === 0 && options.declaredFrames !== undefined) {
      const first = mp3Frame(0x90, FRAME_128_BYTES);

      first.write("Xing", 36, "ascii");
      first.writeUInt32BE(0x01, 40);
      first.writeUInt32BE(options.declaredFrames, 44);
      audio.push(first);
    } else if (options.variableBitrate === true && number % 2 === 1) {
      // 160 kbps: a different bitrate in the same stream.
      audio.push(mp3Frame(0xa0, FRAME_160_BYTES));
    } else {
      audio.push(mp3Frame(0x90, FRAME_128_BYTES));
    }
  }

  const end =
    options.id3v1 === true ? [Buffer.concat([Buffer.from("TAG"), Buffer.alloc(125)])] : [];

  return Buffer.concat([tag, ...audio, ...end]);
}

export interface Mp4Options extends MediaFixtureOptions {
  durationSeconds?: number;
  /** `moov` after `mdat`, as files that were not optimized for streaming have it. */
  moovAtEnd?: boolean;
  /** Version 1 `mvhd` (64-bit duration). */
  version1?: boolean;
  /** Leave the `moov` box out: the length cannot be read. */
  noMoov?: boolean;
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);

  header.writeUInt32BE(8 + payload.byteLength);
  header.write(type, 4, "ascii");

  return Buffer.concat([header, payload]);
}

/** An MP4 whose `mvhd` says `durationSeconds` (default 60). */
export function buildMp4(options: Mp4Options = {}): Buffer {
  const seconds = options.durationSeconds ?? 60;
  const timescale = 1000;
  const mvhd = Buffer.alloc(options.version1 === true ? 112 : 100);

  if (options.version1 === true) {
    mvhd[0] = 1;
    mvhd.writeUInt32BE(timescale, 20);
    mvhd.writeBigUInt64BE(BigInt(seconds * timescale), 24);
  } else {
    mvhd.writeUInt32BE(timescale, 12);
    mvhd.writeUInt32BE(seconds * timescale, 16);
  }

  const ftyp = box(
    "ftyp",
    Buffer.concat([Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isom")]),
  );
  const free = box("free", marker(options));
  const moov = options.noMoov === true ? Buffer.alloc(0) : box("moov", box("mvhd", mvhd));
  const mdat = box("mdat", Buffer.from("not really video"));

  return Buffer.concat(
    options.moovAtEnd === true ? [ftyp, free, mdat, moov] : [ftyp, free, moov, mdat],
  );
}
