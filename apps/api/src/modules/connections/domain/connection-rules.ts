import type { Connection, ConnectionKind } from "./connection";

/** Largest accepted document: PDF, TXT or Markdown (spec 0023, R2). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const MB = 1024 * 1024;

/** Largest accepted image (spec 0026, R1): below the multipart limit, checked by the use case. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Largest accepted file of each kind: documents 20 MB, images 10 MB, MP3 50 MB, MP4 200 MB. */
export const MAX_BYTES_BY_KIND: Readonly<Record<ConnectionKind, number>> = {
  pdf: MAX_FILE_BYTES,
  txt: MAX_FILE_BYTES,
  md: MAX_FILE_BYTES,
  image: MAX_IMAGE_BYTES,
  audio: 50 * MB,
  video: 200 * MB,
};

/** The multipart limit: the largest of the kinds. The use case then applies the limit of the kind. */
export const MAX_UPLOAD_BYTES = 200 * MB;

/** Longest accepted media, read from its metadata: MP3 60 minutes, MP4 20 minutes (R1). */
export const MAX_DURATION_SECONDS_BY_KIND: Readonly<Partial<Record<ConnectionKind, number>>> = {
  audio: 60 * 60,
  video: 20 * 60,
};

/** True for the kinds that go through the media understanding port (Gemini). */
export function isMediaKind(kind: ConnectionKind): boolean {
  return kind === "audio" || kind === "video";
}

/** Media jobs of one user running at once; one more is `409 TOO_MANY_PROCESSING` (R5). */
export const MAX_SIMULTANEOUS_MEDIA_PER_USER = 2;

/** Seconds of media one user may start processing in a rolling 24 hours: 100 minutes (R10). */
export const MAX_MEDIA_SECONDS_PER_DAY = 100 * 60;

/** Longest one attempt at understanding a media may take before it is given up (R5). */
export const MEDIA_ATTEMPT_TIMEOUT_MS = 10 * 60_000;

/** Attempts at understanding a media on 429, 5xx or network failure (R5). */
export const MEDIA_MAX_ATTEMPTS = 2;

/**
 * The whole extraction of a media (two attempts and the wait between them) must end before this,
 * and before `STALE_MEDIA_PROCESSING_MS`.
 */
export const MEDIA_EXTRACTION_TIMEOUT_MS = 22 * 60_000;

/** Media jobs running at once and waiting: they hold the whole file in memory (up to 200 MB). */
export const MEDIA_CONCURRENCY = 3;
export const MAX_WAITING_MEDIA_JOBS = 3;

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

/** Same for an audio or a video, which legitimately take longer (spec 0028, R5). */
export const STALE_MEDIA_PROCESSING_MS = 30 * 60_000;

/** How long a `processing` connection of this kind may go without a worker before it is stale. */
export function staleProcessingMsOf(kind: ConnectionKind): number {
  return isMediaKind(kind) ? STALE_MEDIA_PROCESSING_MS : STALE_PROCESSING_MS;
}

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
  mp3: "audio",
  mp4: "video",
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
  "audio/mpeg",
  "audio/mp3",
  "audio/x-mpeg",
  "video/mp4",
  "application/octet-stream",
  "",
]);

const EXTENSION_OF_KIND: Readonly<Record<ConnectionKind, string>> = {
  pdf: "pdf",
  txt: "txt",
  md: "md",
  image: "jpg",
  audio: "mp3",
  video: "mp4",
};

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
  return MAX_BYTES_BY_KIND[kind];
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

  return name === "" ? `file.${EXTENSION_OF_KIND[kind]}` : name;
}

/** True when a `processing` connection outlived its worker. */
export function isStaleProcessing(connection: Connection, now: Date): boolean {
  return (
    connection.status === "processing" &&
    now.getTime() - connection.updatedAt.getTime() > staleProcessingMsOf(connection.kind)
  );
}
