import {
  type ExternalUrl,
  InvalidUrlError,
  isAddressLiteral,
  bareHostname,
  parseExternalUrl,
  UrlNotAllowedError,
} from "../domain/external-url";
import { addressFamily, isPublicAddress } from "../domain/ip-address";
import {
  ACCEPTED_MEDIA_TYPES,
  type DnsResolver,
  FETCH_MAX_ATTEMPTS,
  FETCH_TIMEOUT_MS,
  type FetchedPage,
  type HttpTransport,
  MAX_PAGE_BYTES,
  MAX_REDIRECTS,
  type PageMediaType,
  type TransportResponse,
  UrlFetchError,
  type UrlFetcher,
} from "../domain/url-fetch";

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const REQUEST_HEADERS = {
  "user-agent": "Rondo-Link-Fetcher/1.0",
  accept: "text/html, text/plain, text/markdown, application/pdf",
  "accept-encoding": "gzip, deflate, br",
  connection: "close",
} as const;

export interface ProtectedUrlFetcherOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxAttempts?: number;
  maxRedirects?: number;
  /** Pause before the second attempt. */
  retryDelayMs?: number;
}

type Hop = { kind: "page"; page: FetchedPage } | { kind: "redirect"; next: ExternalUrl };

/** A failure worth another attempt: the network or a 5xx, never a 4xx and never a timeout. */
class RetryableFailure extends Error {}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function mediaTypeOf(header: string | undefined): {
  mediaType: PageMediaType | null;
  charset?: string;
} {
  if (header === undefined) {
    return { mediaType: null };
  }

  const [rawType = "", ...parameters] = header.split(";");
  const type = rawType.trim().toLowerCase();
  const mediaType = ACCEPTED_MEDIA_TYPES.find((accepted) => accepted === type) ?? null;
  const charset = parameters
    .map((parameter) => parameter.trim().match(/^charset\s*=\s*"?([^";\s]+)"?$/i)?.[1])
    .find((value) => value !== undefined);

  return charset === undefined ? { mediaType } : { mediaType, charset: charset.toLowerCase() };
}

/**
 * The only way the API reaches a link (spec 0027, ADR of the egress policy). For every hop it:
 *
 * 1. resolves the host once and checks **every** address: one non-public address and nothing is
 *    requested (`URL_NOT_ALLOWED`);
 * 2. connects to the address it validated (the transport receives the IP, so there is no second
 *    lookup for a rebinding server to answer differently);
 * 3. follows a redirect only after the new link passes the same rules (at most 3 hops, `http` and
 *    `https` only, ports 80 and 443);
 * 4. enforces the time (15 s per attempt, DNS included), the size (5 MB, counted on the
 *    decompressed bytes, reading stops when exceeded, `Content-Length` is only a hint) and the
 *    content type (HTML, text, Markdown and PDF).
 *
 * It tries twice on a network failure or a 5xx, never on a 4xx or a timeout. Errors carry a closed
 * code: no message holds the link, the host or any part of the response.
 */
export class ProtectedUrlFetcher implements UrlFetcher {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxAttempts: number;
  private readonly maxRedirects: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly resolver: DnsResolver,
    private readonly transport: HttpTransport,
    options: ProtectedUrlFetcherOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? MAX_PAGE_BYTES;
    this.maxAttempts = options.maxAttempts ?? FETCH_MAX_ATTEMPTS;
    this.maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
    this.retryDelayMs = options.retryDelayMs ?? 250;
  }

  async fetch(start: ExternalUrl): Promise<FetchedPage> {
    let current = start;

    for (let redirects = 0; ; redirects += 1) {
      const hop = await this.fetchHop(current, redirects);

      if (hop.kind === "page") {
        return hop.page;
      }

      if (redirects >= this.maxRedirects) {
        throw new UrlFetchError("TOO_MANY_REDIRECTS");
      }

      current = hop.next;
    }
  }

  private async fetchHop(url: ExternalUrl, redirects: number): Promise<Hop> {
    const addresses = await this.validatedAddresses(url, redirects);

    for (let attempt = 0; ; attempt += 1) {
      // The second attempt uses the next validated address when the name has more than one.
      const address = addresses[attempt % addresses.length] as string;

      try {
        return await this.attempt(url, address);
      } catch (error) {
        if (!(error instanceof RetryableFailure)) {
          throw error;
        }

        if (attempt + 1 >= this.maxAttempts) {
          throw new UrlFetchError("FETCH_FAILED");
        }

        await pause(this.retryDelayMs);
      }
    }
  }

  /** Resolves the host once (an address literal needs no lookup) and refuses non-public answers. */
  private async validatedAddresses(url: ExternalUrl, redirects: number): Promise<string[]> {
    const blockedAt = redirects === 0 ? "address" : "redirect";
    const host = bareHostname(url.url);
    let addresses: string[];

    if (isAddressLiteral(url.url)) {
      addresses = [host];
    } else {
      addresses = await this.resolve(host);
    }

    if (addresses.length === 0) {
      throw new UrlFetchError("FETCH_FAILED");
    }

    if (!addresses.every((address) => isPublicAddress(address))) {
      throw new UrlFetchError("URL_NOT_ALLOWED", blockedAt);
    }

    return addresses;
  }

  private async resolve(host: string): Promise<string[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UrlFetchError("FETCH_TIMEOUT")), this.timeoutMs);
    });

    try {
      return await Promise.race([this.resolver.resolve(host), timeout]);
    } catch (error) {
      throw error instanceof UrlFetchError ? error : new UrlFetchError("FETCH_FAILED");
    } finally {
      clearTimeout(timer);
    }
  }

  private async attempt(url: ExternalUrl, address: string): Promise<Hop> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: TransportResponse | undefined;

    try {
      response = await this.transport.request({
        url: url.url,
        address,
        family: addressFamily(address) ?? 4,
        headers: REQUEST_HEADERS,
        signal: controller.signal,
      });

      return await this.handle(url, response);
    } catch (error) {
      if (error instanceof UrlFetchError) {
        throw error;
      }

      if (controller.signal.aborted) {
        throw new UrlFetchError("FETCH_TIMEOUT");
      }

      throw error instanceof RetryableFailure ? error : new RetryableFailure();
    } finally {
      clearTimeout(timer);
      response?.close();
    }
  }

  private async handle(url: ExternalUrl, response: TransportResponse): Promise<Hop> {
    const { status, headers } = response;

    if (REDIRECT_STATUSES.has(status)) {
      return { kind: "redirect", next: this.nextHop(url, headers.location) };
    }

    if (status >= 500) {
      throw new RetryableFailure();
    }

    if (status < 200 || status > 299 || status === 204) {
      throw new UrlFetchError("FETCH_FAILED");
    }

    const { mediaType, charset } = mediaTypeOf(headers["content-type"]);

    if (mediaType === null) {
      throw new UrlFetchError("UNSUPPORTED_CONTENT_TYPE");
    }

    const declared = Number(headers["content-length"]);

    if (Number.isFinite(declared) && declared > this.maxBytes) {
      throw new UrlFetchError("RESPONSE_TOO_LARGE");
    }

    const bytes = await this.read(response);

    return {
      kind: "page",
      page: charset === undefined ? { bytes, mediaType } : { bytes, mediaType, charset },
    };
  }

  /** A redirect target goes through the same rules as the link the user gave. */
  private nextHop(from: ExternalUrl, location: string | undefined): ExternalUrl {
    if (location === undefined || location === "") {
      throw new UrlFetchError("FETCH_FAILED");
    }

    try {
      return parseExternalUrl(location, { base: from.url.href, source: "redirect" });
    } catch (error) {
      if (error instanceof UrlNotAllowedError) {
        throw new UrlFetchError("URL_NOT_ALLOWED", "redirect");
      }

      if (error instanceof InvalidUrlError && error.reason !== "malformed") {
        throw new UrlFetchError("URL_NOT_ALLOWED", "redirect");
      }

      throw new UrlFetchError("FETCH_FAILED");
    }
  }

  /** Reads the body and stops as soon as it is larger than the limit. */
  private async read(response: TransportResponse): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;

    for await (const chunk of response.body) {
      total += chunk.byteLength;

      if (total > this.maxBytes) {
        throw new UrlFetchError("RESPONSE_TOO_LARGE");
      }

      chunks.push(chunk);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return bytes;
  }
}
