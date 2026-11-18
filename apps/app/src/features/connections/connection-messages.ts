import { ApiError } from "../../lib/api-client";

/** Largest file the API accepts. Checked here too so a big file is not uploaded for nothing. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const ACCEPTED_EXTENSIONS = [".pdf", ".txt", ".md"] as const;

export type ConnectionStatus = "processing" | "ready" | "failed";

export interface ConnectionDto {
  id: string;
  name: string;
  kind: "pdf" | "txt" | "md" | "url";
  sizeBytes: number;
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
  // Links (spec 0027). The reason of a blocked link is never explained: only that it can't be used.
  URL_NOT_ALLOWED: { text: "This link can't be used.", retryable: false },
  FETCH_FAILED: { text: "We couldn't open this link. Check it and try again.", retryable: true },
  FETCH_TIMEOUT: {
    text: "The page took too long to answer. Try again in a moment.",
    retryable: true,
  },
  RESPONSE_TOO_LARGE: {
    text: "This page is too large. Links can have at most 5 MB.",
    retryable: false,
  },
  UNSUPPORTED_CONTENT_TYPE: {
    text: "This link must lead to a web page, a text file, Markdown or a PDF.",
    retryable: false,
  },
  TOO_MANY_REDIRECTS: { text: "This link redirects too many times.", retryable: false },
};

/** What `NO_EXTRACTABLE_TEXT` and `PDF_PROTECTED` say when the source is a link, not a file. */
const BY_LINK_CODE: Record<string, FailureMessage> = {
  NO_EXTRACTABLE_TEXT: {
    text: "We couldn't find any text on this page. Pages that need a login or JavaScript are not supported.",
    retryable: false,
  },
  PDF_PROTECTED: {
    text: "This PDF is protected by a password and can't be used.",
    retryable: false,
  },
  PROCESSING_UNAVAILABLE: {
    text: "We couldn't process this link right now. Try again in a moment.",
    retryable: true,
  },
};

const GENERIC_LINK: FailureMessage = {
  text: "We couldn't connect this link. Try again in a moment.",
  retryable: true,
};

const GENERIC: FailureMessage = {
  text: "We couldn't connect this file. Try again in a moment.",
  retryable: true,
};

/** The fixed message of a `failed` connection, by the code the API gives. */
export function describeProcessingFailure(
  errorCode: string | null,
  kind?: ConnectionDto["kind"],
): FailureMessage {
  if (errorCode !== null && kind === "url" && BY_LINK_CODE[errorCode] !== undefined) {
    return BY_LINK_CODE[errorCode];
  }

  return (
    (errorCode === null ? undefined : BY_PROCESSING_CODE[errorCode]) ??
    (kind === "url" ? GENERIC_LINK : GENERIC)
  );
}

/** The message of a refused upload (a 4xx or a network failure of `POST /connections`). */
export function describeUploadFailure(error: unknown): FailureMessage {
  if (!(error instanceof ApiError)) {
    return GENERIC;
  }

  switch (error.code) {
    case "UNSUPPORTED_FILE":
      return { text: "Only PDF, TXT and Markdown files are supported.", retryable: false };
    case "FILE_TOO_LARGE":
      return { text: "Files can have at most 20 MB.", retryable: false };
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

/** The message of a refused link (a 4xx, 5xx or a network failure of `POST /connections/url`). */
export function describeLinkFailure(error: unknown): FailureMessage {
  if (!(error instanceof ApiError)) {
    return GENERIC_LINK;
  }

  switch (error.code) {
    case "INVALID_URL":
      return { text: "Enter a valid link that starts with http:// or https://.", retryable: false };
    case "VALIDATION_FAILED":
      return { text: "Links can have at most 2,048 characters.", retryable: false };
    case "CONNECTION_LIMIT_REACHED":
      return { text: "You reached the limit of 50 connections.", retryable: false };
    case "RATE_LIMITED":
      return { text: "Too many links. Try again in a few minutes.", retryable: true };
    case "NETWORK_ERROR":
      return {
        text: "We couldn't reach the server. Check your connection and try again.",
        retryable: true,
      };
    default:
      return describeProcessingFailure(error.code, "url");
  }
}

const MAX_LINK_LENGTH = 2048;

/**
 * The message for a link the browser already knows is wrong (not a plain http(s) link), or `null`
 * when it can be sent. The server checks everything again; this only saves a round trip.
 */
export function checkLinkBeforeSend(text: string): string | null {
  const value = text.trim();

  if (value === "") {
    return "Enter a link.";
  }

  if (value.length > MAX_LINK_LENGTH) {
    return "Links can have at most 2,048 characters.";
  }

  try {
    const url = new URL(value);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Links must start with http:// or https://.";
    }

    if (url.username !== "" || url.password !== "") {
      return "Links can't contain a user name or password.";
    }

    if (url.port !== "" && url.port !== "80" && url.port !== "443") {
      return "Links can only use the default web ports.";
    }

    return null;
  } catch {
    return "Enter a valid link that starts with http:// or https://.";
  }
}

/** What the chip of a link shows: host and path, never the query or the fragment (they may hold a token). */
export function linkLabel(text: string): string {
  try {
    const url = new URL(text.trim());
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");

    return `${url.host}${path}`;
  } catch {
    return "Link";
  }
}

/** The message for a file the browser already knows is wrong, or `null` when it can be sent. */
export function checkFileBeforeUpload(file: File): FailureMessage | null {
  const name = file.name.toLowerCase();

  if (!ACCEPTED_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return { text: "Only PDF, TXT and Markdown files are supported.", retryable: false };
  }

  if (file.size === 0) {
    return { text: "This file is empty.", retryable: false };
  }

  if (file.size > MAX_FILE_BYTES) {
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
  url: "Link",
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
