import type { ExtractedSection } from "./connection-ports";
import type { ExternalUrl } from "./external-url";

/** Largest body read from a link, also after decompression (R4). */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;

/** Total time of one attempt: connection, headers and body (R4). */
export const FETCH_TIMEOUT_MS = 15_000;

/** Attempts on a network failure or a 5xx (R4). Never on a 4xx. */
export const FETCH_MAX_ATTEMPTS = 2;

/** Redirects followed; each one is checked again (R3). */
export const MAX_REDIRECTS = 3;

/** Searches of a link running at once: a burst of links cannot exhaust sockets and memory. */
export const URL_INGESTION_CONCURRENCY = 4;

export const ACCEPTED_MEDIA_TYPES = [
  "text/html",
  "text/plain",
  "text/markdown",
  "application/pdf",
] as const;

export type PageMediaType = (typeof ACCEPTED_MEDIA_TYPES)[number];

/** Why a link could not be turned into text: a closed set, each code with a fixed message. */
export const URL_FETCH_ERROR_CODES = [
  "URL_NOT_ALLOWED",
  "FETCH_FAILED",
  "FETCH_TIMEOUT",
  "RESPONSE_TOO_LARGE",
  "UNSUPPORTED_CONTENT_TYPE",
  "TOO_MANY_REDIRECTS",
] as const;

export type UrlFetchErrorCode = (typeof URL_FETCH_ERROR_CODES)[number];

/** Where a blocked request was stopped: the link itself (`address`) or a redirect it led to. */
export type UrlBlockedAt = "address" | "redirect";

/** The page could not be fetched. The message is fixed: never the link, host or response. */
export class UrlFetchError extends Error {
  constructor(
    readonly code: UrlFetchErrorCode,
    readonly blockedAt?: UrlBlockedAt,
  ) {
    super(`Link fetch failed: ${code}`);
    this.name = "UrlFetchError";
  }
}

/** What came back from a link: the body (at most 5 MB) and what the server said it is. */
export interface FetchedPage {
  bytes: Uint8Array;
  mediaType: PageMediaType;
  /** From `Content-Type`, when given. */
  charset?: string;
}

/**
 * The only way the API reaches a link. Implementations never make a request to a non-public
 * address and never keep the page.
 */
export interface UrlFetcher {
  fetch(url: ExternalUrl): Promise<FetchedPage>;
}

/** Every address (A and AAAA) of a name. Throws when it does not resolve. */
export interface DnsResolver {
  resolve(hostname: string): Promise<string[]>;
}

export interface TransportRequest {
  url: URL;
  /** The address already validated: the connection goes here, whatever the name resolves to now. */
  address: string;
  family: 4 | 6;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Lower-case names. */
  headers: Readonly<Record<string, string | undefined>>;
  /** Already decompressed. */
  body: AsyncIterable<Uint8Array>;
  /** Stops the transfer and frees the socket. */
  close(): void;
}

/** One HTTP request to a given address, no redirects. */
export interface HttpTransport {
  request(request: TransportRequest): Promise<TransportResponse>;
}

/** The text of a page and its title, when it has one. */
export interface UrlContent {
  sections: ExtractedSection[];
  title?: string;
}

/** Turns a fetched page into text. It never makes a request. */
export interface UrlContentExtractor {
  extract(page: FetchedPage): Promise<UrlContent>;
}
