import type { ConnectionKind } from "./connection";
import { MAX_IMAGE_SIDE_PX, maxBytesOfKind } from "./connection-rules";
import { InvalidUploadError } from "./connection-errors";
import { readImageInfo } from "./image-format";

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

/**
 * An image is JPEG or PNG by its signature and its header gives a size within the limit (spec 0026,
 * R1). A file whose header cannot be read is not an image the vision model can be sent.
 */
function assertImage(bytes: Uint8Array): void {
  const info = readImageInfo(bytes);

  if (info === null || info.width === 0 || info.height === 0) {
    throw new InvalidUploadError("UNSUPPORTED_FILE");
  }

  if (info.width > MAX_IMAGE_SIDE_PX || info.height > MAX_IMAGE_SIDE_PX) {
    throw new InvalidUploadError("IMAGE_TOO_LARGE");
  }
}

/**
 * Checks the bytes of an upload (R2): not empty, within the size limit of its kind (20 MB, 10 MB
 * for an image) and with the signature of its kind (`%PDF-` for PDF, valid UTF-8 without NUL bytes
 * for TXT and Markdown, JPEG or PNG with a readable size up to 8,000 px for an image). The
 * extension and the content type were already checked, but they are claims: only the bytes decide.
 */
export function assertUploadContent(kind: ConnectionKind, bytes: Uint8Array): void {
  if (bytes.byteLength === 0) {
    throw new InvalidUploadError("EMPTY_FILE");
  }

  if (bytes.byteLength > maxBytesOfKind(kind)) {
    throw new InvalidUploadError("FILE_TOO_LARGE");
  }

  if (kind === "image") {
    assertImage(bytes);

    return;
  }

  const valid = kind === "pdf" ? hasPdfSignature(bytes) : isUtf8Text(bytes);

  if (!valid) {
    throw new InvalidUploadError("UNSUPPORTED_FILE");
  }
}
