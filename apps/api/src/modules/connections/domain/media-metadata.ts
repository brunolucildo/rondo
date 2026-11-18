/**
 * Signatures and durations of MP3 and MP4 files, read from their headers (spec 0028, R1). Nothing
 * here decodes audio or video: the length comes from the metadata (the Xing/Info and VBRI headers
 * or the constant bitrate of an MP3; the `mvhd` box of an MP4), so a large file costs a few reads.
 * A duration that cannot be determined is `null`; the caller refuses the file.
 */

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ---------------------------------------------------------------------------------------------
// MP3
// ---------------------------------------------------------------------------------------------

/** Bytes of an ID3v2 tag header. */
const ID3_HEADER_BYTES = 10;
/** An MP3 frame header: eleven bits of sync (`FF Ex` or higher). */
const isSync = (bytes: Uint8Array, offset: number): boolean =>
  (bytes[offset] ?? 0) === 0xff && ((bytes[offset + 1] ?? 0) & 0xe0) === 0xe0;

/** True when the bytes start like an MP3: an ID3v2 tag (`ID3`) or an MPEG audio frame (`FF Fx`). */
export function hasMp3Signature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 3) {
    return false;
  }

  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true;
  }

  return bytes.byteLength >= 2 && (bytes[0] ?? 0) === 0xff && ((bytes[1] ?? 0) & 0xf0) === 0xf0;
}

/** True when bytes 4 to 8 spell `ftyp`: the first box of every MP4. */
export function hasMp4Signature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  );
}

const MPEG1_L3_BITRATES_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3_BITRATES_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Readonly<Record<"1" | "2" | "2.5", readonly number[]>> = {
  "1": [44100, 48000, 32000],
  "2": [22050, 24000, 16000],
  "2.5": [11025, 12000, 8000],
};

interface Mp3Frame {
  /** Offset of the frame header inside the file. */
  offset: number;
  bitrate: number;
  sampleRate: number;
  samplesPerFrame: number;
  frameBytes: number;
  mono: boolean;
  mpeg1: boolean;
  hasCrc: boolean;
}

/** Reads the header at `offset`; `null` when it is not a valid Layer III frame header. */
function readMp3Frame(bytes: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > bytes.byteLength || !isSync(bytes, offset)) {
    return null;
  }

  const second = bytes[offset + 1] ?? 0;
  const third = bytes[offset + 2] ?? 0;
  const fourth = bytes[offset + 3] ?? 0;
  const versionBits = (second >> 3) & 0x03;
  const layerBits = (second >> 1) & 0x03;
  const bitrateIndex = (third >> 4) & 0x0f;
  const rateIndex = (third >> 2) & 0x03;

  // Version 1 is reserved; only Layer III (bits 01) is an MP3.
  if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15) {
    return null;
  }

  if (rateIndex === 3) {
    return null;
  }

  const family = versionBits === 3 ? "1" : versionBits === 2 ? "2" : "2.5";
  const sampleRate = SAMPLE_RATES[family][rateIndex];
  const kbps = (family === "1" ? MPEG1_L3_BITRATES_KBPS : MPEG2_L3_BITRATES_KBPS)[bitrateIndex];

  if (sampleRate === undefined || kbps === undefined) {
    return null;
  }

  const bitrate = kbps * 1000;
  const padding = (third >> 1) & 0x01;
  const mpeg1 = family === "1";
  const samplesPerFrame = mpeg1 ? 1152 : 576;
  const frameBytes = Math.floor(((samplesPerFrame / 8) * bitrate) / sampleRate) + padding;

  return {
    offset,
    bitrate,
    sampleRate,
    samplesPerFrame,
    frameBytes,
    mono: fourth >> 6 === 3,
    mpeg1,
    hasCrc: (second & 0x01) === 0,
  };
}

/** Offset after the ID3v2 tags at the start (a file may carry more than one). */
function skipId3v2(bytes: Uint8Array): number {
  let offset = 0;

  while (
    offset + ID3_HEADER_BYTES <= bytes.byteLength &&
    bytes[offset] === 0x49 &&
    bytes[offset + 1] === 0x44 &&
    bytes[offset + 2] === 0x33
  ) {
    const flags = bytes[offset + 5] ?? 0;
    const size =
      ((bytes[offset + 6] ?? 0) & 0x7f) * 0x200000 +
      ((bytes[offset + 7] ?? 0) & 0x7f) * 0x4000 +
      ((bytes[offset + 8] ?? 0) & 0x7f) * 0x80 +
      ((bytes[offset + 9] ?? 0) & 0x7f);
    const footer = (flags & 0x10) === 0 ? 0 : 10;

    offset += ID3_HEADER_BYTES + size + footer;
  }

  return offset;
}

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

/** Frame count promised by a Xing/Info or VBRI header in the first frame, if there is one. */
function declaredFrameCount(bytes: Uint8Array, frame: Mp3Frame): number | null {
  const data = view(bytes);
  const sideInfo = frame.mpeg1 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
  const xing = frame.offset + 4 + (frame.hasCrc ? 2 : 0) + sideInfo;

  if (xing + 12 <= bytes.byteLength) {
    const tag = ascii(bytes, xing, 4);

    if (tag === "Xing" || tag === "Info") {
      const flags = data.getUint32(xing + 4);

      return (flags & 0x01) === 0 ? null : data.getUint32(xing + 8);
    }
  }

  const vbri = frame.offset + 4 + 32;

  if (vbri + 18 <= bytes.byteLength && ascii(bytes, vbri, 4) === "VBRI") {
    return data.getUint32(vbri + 14);
  }

  return null;
}

/**
 * Length of an MP3 in whole seconds (rounded up), or `null` when it cannot be known. A Xing, Info
 * or VBRI header gives the frame count. Without one the file must be constant bitrate: the next
 * frames are walked and a different bitrate (a variable bitrate file with no header) makes the
 * length unknowable. The ID3v1 tag at the end (128 bytes) is not audio.
 */
export function readMp3DurationSeconds(bytes: Uint8Array): number | null {
  let offset = skipId3v2(bytes);

  // Junk between the tag and the first frame is tolerated, within a small window.
  const windowEnd = Math.min(bytes.byteLength - 4, offset + 4096);
  let first: Mp3Frame | null = null;

  for (; offset <= windowEnd; offset += 1) {
    first = readMp3Frame(bytes, offset);

    if (first !== null) {
      break;
    }
  }

  if (first === null) {
    return null;
  }

  const declared = declaredFrameCount(bytes, first);

  if (declared !== null) {
    return declared > 0 ? Math.ceil((declared * first.samplesPerFrame) / first.sampleRate) : null;
  }

  let cursor = first.offset;

  for (let walked = 0; walked < 16; walked += 1) {
    // The audio ends where the bytes do, or where the ID3v1 tag starts.
    if (cursor + 4 > bytes.byteLength || (walked > 0 && ascii(bytes, cursor, 3) === "TAG")) {
      break;
    }

    const current = readMp3Frame(bytes, cursor);

    if (current === null || current.frameBytes < 4 || current.bitrate !== first.bitrate) {
      return null;
    }

    cursor += current.frameBytes;
  }

  const hasId3v1 =
    bytes.byteLength - 128 > first.offset && ascii(bytes, bytes.byteLength - 128, 3) === "TAG";
  const audioBytes = bytes.byteLength - first.offset - (hasId3v1 ? 128 : 0);

  return audioBytes <= 0 ? null : Math.ceil((audioBytes * 8) / first.bitrate);
}

// ---------------------------------------------------------------------------------------------
// MP4
// ---------------------------------------------------------------------------------------------

interface Mp4Box {
  type: string;
  /** Offset of the first byte of the payload. */
  start: number;
  /** Offset after the last byte of the box. */
  end: number;
}

/** The boxes that sit side by side in `[from, to)`; stops at the first one that does not fit. */
function readBoxes(bytes: Uint8Array, from: number, to: number): Mp4Box[] {
  const data = view(bytes);
  const boxes: Mp4Box[] = [];
  let offset = from;

  while (offset + 8 <= to) {
    let size = data.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    let header = 8;

    if (size === 1) {
      if (offset + 16 > to) {
        break;
      }

      const large = data.getBigUint64(offset + 8);

      if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
        break;
      }

      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = to - offset;
    }

    if (size < header || offset + size > to) {
      break;
    }

    boxes.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }

  return boxes;
}

function seconds(duration: number, timescale: number): number | null {
  return timescale > 0 && duration > 0 ? Math.ceil(duration / timescale) : null;
}

/**
 * Length of an MP4 in whole seconds (rounded up), from the `mvhd` box inside `moov` (or, for a
 * fragmented file whose `mvhd` says zero, from the `mehd` fragment duration). `null` when there is
 * no `moov`, the box is cut short or the length is zero.
 */
export function readMp4DurationSeconds(bytes: Uint8Array): number | null {
  const data = view(bytes);
  const moov = readBoxes(bytes, 0, bytes.byteLength).find((box) => box.type === "moov");

  if (moov === undefined) {
    return null;
  }

  const children = readBoxes(bytes, moov.start, moov.end);
  const mvhd = children.find((box) => box.type === "mvhd");

  if (mvhd === undefined || mvhd.start + 20 > mvhd.end) {
    return null;
  }

  const version = bytes[mvhd.start] ?? 0;
  let timescale: number;
  let duration: number;

  if (version === 1) {
    if (mvhd.start + 32 > mvhd.end) {
      return null;
    }

    timescale = data.getUint32(mvhd.start + 20);
    duration = Number(data.getBigUint64(mvhd.start + 24));
  } else {
    timescale = data.getUint32(mvhd.start + 12);
    duration = data.getUint32(mvhd.start + 16);
  }

  const fromHeader = seconds(duration, timescale);

  if (fromHeader !== null) {
    return fromHeader;
  }

  const mvex = children.find((box) => box.type === "mvex");
  const mehd =
    mvex === undefined
      ? undefined
      : readBoxes(bytes, mvex.start, mvex.end).find((box) => box.type === "mehd");

  if (mehd === undefined || mehd.start + 8 > mehd.end) {
    return null;
  }

  const fragment =
    (bytes[mehd.start] ?? 0) === 1 && mehd.start + 12 <= mehd.end
      ? Number(data.getBigUint64(mehd.start + 4))
      : data.getUint32(mehd.start + 4);

  return seconds(fragment, timescale);
}
