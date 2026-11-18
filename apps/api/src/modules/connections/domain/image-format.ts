/** The two image formats a connection accepts (spec 0026). */
export type ImageMimeType = "image/jpeg" | "image/png";

export interface ImageInfo {
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  bytes.byteLength >= signature.length && signature.every((value, index) => bytes[index] === value);

/** The format of the bytes by their signature (JPEG `FF D8 FF`, PNG `89 50 4E 47`), else `null`. */
export function detectImageMimeType(bytes: Uint8Array): ImageMimeType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return "image/png";
  }

  return startsWith(bytes, JPEG_SIGNATURE) ? "image/jpeg" : null;
}

function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  // 8 byte signature, then the IHDR chunk: length (4), "IHDR" (4), width (4), height (4).
  if (bytes.byteLength < 24) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isIhdr = view.getUint32(12) === 0x49484452;

  return isIhdr ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
}

/** Markers that start a frame (they carry the size): SOF0 to SOF15 but DHT, JPG and DAC. */
const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function readJpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      return null;
    }

    const marker = bytes[offset + 1] ?? 0;

    if (marker === 0xff) {
      // Fill byte before a marker.
      offset += 1;
      continue;
    }

    // Markers without a length: TEM and RSTn. Reaching EOI or SOS means there was no frame header.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }

    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }

    const length = view.getUint16(offset + 2);

    if (isStartOfFrame(marker)) {
      // Segment: length (2), precision (1), height (2), width (2).
      return offset + 9 <= bytes.byteLength
        ? { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
        : null;
    }

    if (length < 2) {
      return null;
    }

    offset += 2 + length;
  }

  return null;
}

/**
 * The format and the pixel size of a JPEG or PNG, read from the header of the bytes (no decoding,
 * no library). `null` when it is neither, or when the header does not say the size (a damaged file).
 */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  const mimeType = detectImageMimeType(bytes);

  if (mimeType === null) {
    return null;
  }

  const size = mimeType === "image/png" ? readPngSize(bytes) : readJpegSize(bytes);

  return size === null ? null : { mimeType, ...size };
}
