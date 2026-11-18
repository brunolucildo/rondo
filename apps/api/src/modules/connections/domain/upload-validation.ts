import type { ConnectionKind } from "./connection";
import { MAX_BYTES_BY_KIND, MAX_DURATION_SECONDS_BY_KIND } from "./connection-rules";
import { InvalidUploadError } from "./connection-errors";
import {
  hasMp3Signature,
  hasMp4Signature,
  readMp3DurationSeconds,
  readMp4DurationSeconds,
} from "./media-metadata";

const PDF_SIGNATURE = "%PDF-";
/** A PDF reader tolerates a few junk bytes before the header, within this many. */
const PDF_SIGNATURE_WINDOW = 1024;

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function hasPdfSignature(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, PDF_SIGNATURE_WINDOW)).toString("latin1");

  return head.includes(PDF_SIGNATURE);
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) {
    return false;
  }

  try {
    UTF8.decode(bytes);

    return true;
  } catch {
    return false;
  }
}

/** What the bytes told besides being valid. */
export interface UploadContentInfo {
  /** Length of an audio or video read from its metadata; `null` for the other kinds. */
  durationSeconds: number | null;
}

function hasSignature(kind: ConnectionKind, bytes: Uint8Array): boolean {
  switch (kind) {
    case "pdf":
      return hasPdfSignature(bytes);
    case "audio":
      return hasMp3Signature(bytes);
    case "video":
      return hasMp4Signature(bytes);
    default:
      return isUtf8Text(bytes);
  }
}

/**
 * Checks the bytes of an upload (R2): not empty, within the size limit of its kind and with the
 * signature of its kind (`%PDF-` for PDF, valid UTF-8 without NUL bytes for TXT and Markdown, an
 * ID3 tag or an MPEG frame for MP3, an `ftyp` box for MP4). An audio or a video also needs a
 * duration the metadata can tell, within the limit of its kind (spec 0028, R1). The extension and
 * the content type were already checked, but they are claims: only the bytes decide.
 */
export function assertUploadContent(kind: ConnectionKind, bytes: Uint8Array): UploadContentInfo {
  if (bytes.byteLength === 0) {
    throw new InvalidUploadError("EMPTY_FILE");
  }

  if (bytes.byteLength > MAX_BYTES_BY_KIND[kind]) {
    throw new InvalidUploadError("FILE_TOO_LARGE");
  }

  if (!hasSignature(kind, bytes)) {
    throw new InvalidUploadError("UNSUPPORTED_FILE");
  }

  const maxDuration = MAX_DURATION_SECONDS_BY_KIND[kind];

  if (maxDuration === undefined) {
    return { durationSeconds: null };
  }

  const durationSeconds =
    kind === "audio" ? readMp3DurationSeconds(bytes) : readMp4DurationSeconds(bytes);

  if (durationSeconds === null) {
    throw new InvalidUploadError("MEDIA_UNREADABLE");
  }

  if (durationSeconds > maxDuration) {
    throw new InvalidUploadError("MEDIA_TOO_LONG");
  }

  return { durationSeconds };
}
