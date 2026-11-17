import type { ConnectionKind } from "./connection";
import { MAX_FILE_BYTES } from "./connection-rules";
import { InvalidUploadError } from "./connection-errors";

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
 * Checks the bytes of an upload (R2): not empty, within the size limit and with the signature of
 * its kind (`%PDF-` for PDF, valid UTF-8 without NUL bytes for TXT and Markdown). The extension and
 * the content type were already checked, but they are claims: only the bytes decide.
 */
export function assertUploadContent(kind: ConnectionKind, bytes: Uint8Array): void {
  if (bytes.byteLength === 0) {
    throw new InvalidUploadError("EMPTY_FILE");
  }

  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new InvalidUploadError("FILE_TOO_LARGE");
  }

  const valid = kind === "pdf" ? hasPdfSignature(bytes) : isUtf8Text(bytes);

  if (!valid) {
    throw new InvalidUploadError("UNSUPPORTED_FILE");
  }
}
