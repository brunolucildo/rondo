import type { Connection, ConnectionKind } from "./connection";

/** Largest accepted file (R2). Also the multipart limit. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Largest accepted image (spec 0026, R1): below the multipart limit, checked by the use case. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Longest side of an accepted image, in pixels (spec 0026, R1). */
export const MAX_IMAGE_SIDE_PX = 8000;

/** What the vision model may return for one image, in characters; the rest is cut (spec 0026, R3). */
export const MAX_IMAGE_TEXT_CHARS = 4000;

/** One call to the vision model may take this long before it counts as a failed attempt (R4). */
export const VISION_ATTEMPT_TIMEOUT_MS = 30_000;

/** Calls to the vision model per image, the first included (R4). */
export const VISION_MAX_ATTEMPTS = 2;

/** Connections one user can have (R2). Only a new connection counts: a duplicate is never refused. */
export const MAX_CONNECTIONS_PER_USER = 50;

/** Chunks one file may produce before it is refused with `TOO_MANY_CHUNKS` (R6). */
export const MAX_CHUNKS_PER_CONNECTION = 2000;

/** Chunking of the extracted text (R5). */
export const CHUNK_SIZE = 1000;
export const CHUNK_OVERLAP = 150;

/** Longest the extraction may take before it is given up as `PROCESSING_UNAVAILABLE` (risk table). */
export const EXTRACTION_TIMEOUT_MS = 60_000;

/** Same limit for an image: it covers the attempts at the vision model plus the wait between them. */
export const IMAGE_EXTRACTION_TIMEOUT_MS = VISION_MAX_ATTEMPTS * VISION_ATTEMPT_TIMEOUT_MS + 10_000;

/** A `processing` connection older than this lost its worker (API restart): it is `failed` (R6). */
export const STALE_PROCESSING_MS = 15 * 60_000;

/** Processing runs of connections at once, so a burst of uploads cannot exhaust CPU and memory. */
export const PROCESSING_CONCURRENCY = 2;

const MAX_NAME_LENGTH = 255;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for the shape of a connection id, so a malformed id never reaches the database. */
export function isUuidLike(value: string): boolean {
  return UUID.test(value);
}

const KIND_BY_EXTENSION: Readonly<Record<string, ConnectionKind>> = {
  pdf: "pdf",
  txt: "txt",
  md: "md",
  jpg: "image",
  jpeg: "image",
  png: "image",
};

/**
 * Content types a browser or a client may send for these files. `application/octet-stream` and the
 * empty value are there because Windows and several clients send them for `.md`; the signature of
 * the bytes is the real check.
 */
const ACCEPTED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/octet-stream",
  "",
]);

/** Content types of the image formats: the signature of the bytes is the real check. */
const IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/png",
  "application/octet-stream",
  "",
]);

/** `plan.PDF` gives `pdf`; a name without a supported extension gives `null`. */
export function kindOfFileName(fileName: string): ConnectionKind | null {
  const dot = fileName.lastIndexOf(".");

  if (dot < 0) {
    return null;
  }

  return KIND_BY_EXTENSION[fileName.slice(dot + 1).toLowerCase()] ?? null;
}

/** Extension and content type, checked before the content is read. */
export function isAcceptedUpload(fileName: string, contentType: string): boolean {
  const kind = kindOfFileName(fileName);
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

  if (kind === null) {
    return false;
  }

  return (kind === "image" ? IMAGE_CONTENT_TYPES : ACCEPTED_CONTENT_TYPES).has(type);
}

/** The largest file of a kind, in bytes. */
export function maxBytesOfKind(kind: ConnectionKind): number {
  return kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
}

/**
 * The name shown back to the user: no directories, no control characters, at most 255 characters.
 * Browsers send the bare name already; this protects against clients that send a path.
 */
export function sanitizeFileName(rawName: string, kind: ConnectionKind): string {
  const base = rawName.split(/[\\/]/).at(-1) ?? "";
  const printable = Array.from(base).filter((character) => {
    const code = character.codePointAt(0) ?? 0;

    return code > 0x1f && code !== 0x7f;
  });
  const name = printable.slice(0, MAX_NAME_LENGTH).join("").trim();

  return name === "" ? `file.${kind}` : name;
}

/** True when a `processing` connection outlived its worker. */
export function isStaleProcessing(connection: Connection, now: Date): boolean {
  return (
    connection.status === "processing" &&
    now.getTime() - connection.updatedAt.getTime() > STALE_PROCESSING_MS
  );
}
