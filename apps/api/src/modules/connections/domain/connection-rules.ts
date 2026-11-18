import type { Connection, FileConnectionKind } from "./connection";

/** Largest accepted file (R2). Also the multipart limit. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Connections one user can have (R2). Only a new connection counts: a duplicate is never refused. */
export const MAX_CONNECTIONS_PER_USER = 50;

/** Chunks one file may produce before it is refused with `TOO_MANY_CHUNKS` (R6). */
export const MAX_CHUNKS_PER_CONNECTION = 2000;

/** Chunking of the extracted text (R5). */
export const CHUNK_SIZE = 1000;
export const CHUNK_OVERLAP = 150;

/** Longest the extraction may take before it is given up as `PROCESSING_UNAVAILABLE` (risk table). */
export const EXTRACTION_TIMEOUT_MS = 60_000;

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

const KIND_BY_EXTENSION: Readonly<Record<string, FileConnectionKind>> = {
  pdf: "pdf",
  txt: "txt",
  md: "md",
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

/** `plan.PDF` gives `pdf`; a name without a supported extension gives `null`. */
export function kindOfFileName(fileName: string): FileConnectionKind | null {
  const dot = fileName.lastIndexOf(".");

  if (dot < 0) {
    return null;
  }

  return KIND_BY_EXTENSION[fileName.slice(dot + 1).toLowerCase()] ?? null;
}

/** Extension and content type, checked before the content is read. */
export function isAcceptedUpload(fileName: string, contentType: string): boolean {
  return (
    kindOfFileName(fileName) !== null &&
    ACCEPTED_CONTENT_TYPES.has(contentType.split(";")[0]?.trim().toLowerCase() ?? "")
  );
}

/**
 * The name shown back to the user: no directories, no control characters, at most 255 characters.
 * Browsers send the bare name already; this protects against clients that send a path.
 */
export function sanitizeFileName(rawName: string, kind: FileConnectionKind): string {
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
