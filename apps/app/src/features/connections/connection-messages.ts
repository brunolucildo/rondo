import { ApiError } from "../../lib/api-client";

/** Largest document the API accepts. Checked here too so a big file is not uploaded for nothing. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Largest image the API accepts (10 MB); the 8,000 px limit per side is checked by the API. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Largest audio and video (spec 0028): MP3 50 MB, MP4 200 MB. */
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

export const ACCEPTED_EXTENSIONS = [
  ".pdf",
  ".txt",
  ".md",
  ".jpg",
  ".jpeg",
  ".png",
  ".mp3",
  ".mp4",
] as const;

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"] as const;

const isImageName = (fileName: string): boolean => {
  const name = fileName.toLowerCase();

  return IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension));
};

const UNSUPPORTED_TEXT = "Only PDF, TXT, Markdown, JPG, PNG, MP3 and MP4 files are supported.";

export type MediaKind = "audio" | "video";

/** `audio` for an `.mp3`, `video` for an `.mp4`, `null` for anything else (a document). */
export function mediaKindOfFile(file: Pick<File, "name">): MediaKind | null {
  const name = file.name.toLowerCase();

  return name.endsWith(".mp3") ? "audio" : name.endsWith(".mp4") ? "video" : null;
}

/** At most this many audio or video files are sent and processed at once (the server allows 2). */
export const MAX_SIMULTANEOUS_MEDIA = 2;

export type ConnectionStatus = "processing" | "ready" | "failed";

export interface ConnectionDto {
  id: string;
  name: string;
  kind: "pdf" | "txt" | "md" | "image" | "audio" | "video";
  sizeBytes: number;
  /** Seconds of an audio or video; `null` for the other kinds. */
  durationSeconds?: number | null;
  status: ConnectionStatus;
  chunkCount: number;
  errorCode: string | null;
  createdAt: string;
  deduplicated?: boolean;
}

export interface FailureMessage {
  text: string;
  /** True when sending the same file again can work (the cause was not the file). */
  retryable: boolean;
}

const BY_PROCESSING_CODE: Record<string, FailureMessage> = {
  NO_EXTRACTABLE_TEXT: {
    text: "We couldn't find any text in this file. Scanned PDFs are not supported yet.",
    retryable: false,
  },
  PDF_PROTECTED: {
    text: "This PDF is protected by a password. Remove the protection and try again.",
    retryable: false,
  },
  TOO_MANY_CHUNKS: {
    text: "This file is too long to be connected. Split it into smaller files.",
    retryable: false,
  },
  PROCESSING_UNAVAILABLE: {
    text: "We couldn't process this file right now. Try again in a moment.",
    retryable: true,
  },
  MEDIA_UNREADABLE: {
    text: "We couldn't read this audio or video. Export it again as MP3 or MP4 and try again.",
    retryable: false,
  },
  CONTENT_NOT_PROCESSABLE: {
    text: "The provider refused to process this content. Try another file.",
    retryable: false,
  },
};

/** A silent audio or a video with nothing to say or show: the PDF text would be wrong for it. */
const NO_TEXT_IN_MEDIA: FailureMessage = {
  text: "We couldn't find any speech or content in this audio or video.",
  retryable: false,
};

/** What an image says differently from a document when it fails (the code is the same set). */
const BY_IMAGE_PROCESSING_CODE: Record<string, FailureMessage> = {
  NO_EXTRACTABLE_TEXT: {
    text: "We couldn't find any text or relevant content in this image. Send a clearer, well-lit image.",
    retryable: false,
  },
  CONTENT_NOT_PROCESSABLE: {
    text: "The AI provider couldn't process this image. Try another image.",
    retryable: false,
  },
  PROCESSING_UNAVAILABLE: {
    text: "We couldn't process this image right now. Try again in a moment.",
    retryable: true,
  },
};

const GENERIC: FailureMessage = {
  text: "We couldn't connect this file. Try again in a moment.",
  retryable: true,
};

/** The fixed message of a `failed` connection, by the code the API gives (and its kind). */
export function describeProcessingFailure(
  errorCode: string | null,
  kind?: ConnectionDto["kind"],
): FailureMessage {
  if (errorCode === null) {
    return GENERIC;
  }

  if (errorCode === "NO_EXTRACTABLE_TEXT" && (kind === "audio" || kind === "video")) {
    return NO_TEXT_IN_MEDIA;
  }

  return (
    (kind === "image" ? BY_IMAGE_PROCESSING_CODE[errorCode] : undefined) ??
    BY_PROCESSING_CODE[errorCode] ??
    GENERIC
  );
}

/** The message of a refused upload (a 4xx or a network failure of `POST /connections`). */
export function describeUploadFailure(error: unknown, fileName = ""): FailureMessage {
  if (!(error instanceof ApiError)) {
    return GENERIC;
  }

  switch (error.code) {
    case "UNSUPPORTED_FILE":
      return { text: UNSUPPORTED_TEXT, retryable: false };
    case "FILE_TOO_LARGE":
      return {
        text: isImageName(fileName)
          ? "Images can have at most 10 MB."
          : "This file is too large. Documents can have at most 20 MB, MP3 50 MB and MP4 200 MB.",
        retryable: false,
      };
    case "IMAGE_TOO_LARGE":
      return { text: "Images can have at most 8,000 pixels on each side.", retryable: false };
    case "MEDIA_TOO_LONG":
      return {
        text: "Audio can have at most 60 minutes and video at most 20 minutes.",
        retryable: false,
      };
    case "MEDIA_UNREADABLE":
      return {
        text: "We couldn't read the length of this file. Export it again and try again.",
        retryable: false,
      };
    case "TOO_MANY_PROCESSING":
      return {
        text: "You already have 2 audio or video files being processed. Wait for one to finish.",
        retryable: true,
      };
    case "MEDIA_DAILY_LIMIT":
      return {
        text: "You reached the daily limit of 100 minutes of audio and video. Try again tomorrow.",
        retryable: false,
      };
    case "MEDIA_UNAVAILABLE":
      return { text: "Audio and video are not available right now.", retryable: true };
    case "EMPTY_FILE":
      return { text: "This file is empty.", retryable: false };
    case "CONNECTION_LIMIT_REACHED":
      return { text: "You reached the limit of 50 connections.", retryable: false };
    case "RATE_LIMITED":
      return { text: "Too many uploads. Try again in a few minutes.", retryable: true };
    case "NETWORK_ERROR":
      return {
        text: "We couldn't reach the server. Check your connection and try again.",
        retryable: true,
      };
    default:
      return GENERIC;
  }
}

/** The message for a file the browser already knows is wrong, or `null` when it can be sent. */
export function checkFileBeforeUpload(file: File): FailureMessage | null {
  const name = file.name.toLowerCase();

  if (!ACCEPTED_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return { text: UNSUPPORTED_TEXT, retryable: false };
  }

  if (file.size === 0) {
    return { text: "This file is empty.", retryable: false };
  }

  const media = mediaKindOfFile(file);

  if (media === "audio" && file.size > MAX_AUDIO_BYTES) {
    return { text: "MP3 files can have at most 50 MB.", retryable: false };
  }

  if (media === "video" && file.size > MAX_VIDEO_BYTES) {
    return { text: "MP4 files can have at most 200 MB.", retryable: false };
  }

  if (isImageName(name) && file.size > MAX_IMAGE_BYTES) {
    return { text: "Images can have at most 10 MB.", retryable: false };
  }

  if (media === null && file.size > MAX_FILE_BYTES) {
    return { text: "Files can have at most 20 MB.", retryable: false };
  }

  return null;
}

export type DeletionScope = "single" | "all";

/**
 * What to tell the person when a deletion fails, by the code the API gave. `reload` means the
 * list is out of date (the connection is already gone) and must be fetched again.
 */
export function describeDeleteFailure(
  error: unknown,
  scope: DeletionScope,
): { text: string; reload: boolean } {
  if (error instanceof ApiError) {
    if (error.code === "CONNECTION_PROCESSING") {
      return { text: "Wait for it to finish.", reload: false };
    }

    if (error.code === "CONNECTION_NOT_FOUND") {
      return { text: "This connection was already removed.", reload: true };
    }
  }

  return {
    text:
      scope === "single"
        ? "We couldn't delete this connection. Try again."
        : "We couldn't delete your connections. Try again.",
    reload: false,
  };
}

const KIND_LABEL: Record<ConnectionDto["kind"], string> = {
  pdf: "PDF",
  txt: "TXT",
  md: "Markdown",
  image: "Image",
  audio: "Audio",
  video: "Video",
};

export const kindLabel = (kind: ConnectionDto["kind"]): string => KIND_LABEL[kind];

/** "1.2 MB", "34 KB", "512 B": what the list shows for the size of a file. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
};

export const statusLabel = (status: ConnectionStatus): string => STATUS_TEXT[status];

/** `750` is "12:30"; an hour or more reads "1:02:03". How the interface shows a time of a media. */
export function formatTimestamp(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${String(minutes).padStart(2, "0")}:${rest}`;
}
