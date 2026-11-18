import type { KnowledgeIndex } from "../../../knowledge";
import type { Connection, ConnectionErrorCode } from "../../domain/connection";
import {
  ConnectionLimitReachedError,
  ConnectionProcessingError,
} from "../../domain/connection-errors";
import type {
  ConnectionRepository,
  ConnectionTelemetry,
  ContentHasher,
} from "../../domain/connection-ports";
import {
  EXTRACTION_TIMEOUT_MS,
  isStaleProcessing,
  MAX_CONNECTIONS_PER_USER,
  STALE_PROCESSING_MS,
} from "../../domain/connection-rules";
import {
  type ExternalUrl,
  InvalidUrlError,
  parseExternalUrl,
  sanitizeDisplayName,
  UrlNotAllowedError,
} from "../../domain/external-url";
import {
  type FetchedPage,
  UrlFetchError,
  type UrlContent,
  type UrlContentExtractor,
  type UrlFetcher,
  URL_INGESTION_CONCURRENCY,
} from "../../domain/url-fetch";
import type { ConnectionProcessor } from "../services/connection-processor";

export interface ConnectUrlInput {
  /** From the session, never from the request. */
  userId: string;
  /** What the person typed. It lives in this call only: it is never stored, logged or returned. */
  url: string;
}

export interface ConnectUrlResult {
  connection: Connection;
  /** True when the link (or its text) was already connected: nothing new was created. */
  deduplicated: boolean;
}

export interface ConnectUrlOptions {
  extractionTimeoutMs?: number;
  concurrency?: number;
}

const TEXT = new TextEncoder();

class ExtractionTimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExtractionTimeoutError()), ms);
  });

  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const lower = (code: ConnectionErrorCode): Lowercase<ConnectionErrorCode> =>
  code.toLowerCase() as Lowercase<ConnectionErrorCode>;

/**
 * Connects a link (spec 0027). The steps, in order:
 *
 * 1. validate the link (syntax, scheme, no credentials, port, host not internal) and take its
 *    canonical form and hash; a connection of the same user with that hash answers at once
 *    (`deduplicated`), with no request;
 * 2. check the 50 connection limit;
 * 3. fetch the page through the protected client (the only way out) and extract its text. A failure
 *    here creates no connection: the error carries a closed code and sending the link again
 *    repeats the search;
 * 4. take the SHA-256 of the extracted text: a connection of the user with that content answers
 *    (`deduplicated`); otherwise the row is inserted (name: the title or `host/path`) and the
 *    processor chunks, embeds and indexes in the background.
 *
 * A `failed` (or stale `processing`) connection of the same link is removed, vectors first, and
 * the link goes through the steps again: the page may have changed. The link, its host and the
 * page never reach a log, a span or a metric.
 */
export class ConnectUrl {
  private active = 0;
  private readonly extractionTimeoutMs: number;
  private readonly concurrency: number;

  constructor(
    private readonly repository: ConnectionRepository,
    private readonly hasher: ContentHasher,
    private readonly fetcher: UrlFetcher,
    private readonly extractor: UrlContentExtractor,
    private readonly processor: ConnectionProcessor,
    private readonly index: KnowledgeIndex,
    private readonly telemetry: ConnectionTelemetry,
    private readonly now: () => Date = () => new Date(),
    options: ConnectUrlOptions = {},
  ) {
    this.extractionTimeoutMs = options.extractionTimeoutMs ?? EXTRACTION_TIMEOUT_MS;
    this.concurrency = options.concurrency ?? URL_INGESTION_CONCURRENCY;
  }

  async execute({ userId, url }: ConnectUrlInput): Promise<ConnectUrlResult> {
    const startedAt = performance.now();
    const link = this.parse(url);
    const urlHash = this.hasher.sha256(TEXT.encode(link.canonical));
    const known = await this.repository.findByUrlHash(userId, urlHash);

    if (known !== null) {
      const answer = await this.settle(userId, known);

      if (answer !== null) {
        return this.deduplicated(answer, startedAt);
      }
    }

    if ((await this.repository.countByUser(userId)) >= MAX_CONNECTIONS_PER_USER) {
      throw new ConnectionLimitReachedError();
    }

    if (this.active >= this.concurrency) {
      throw new ConnectionProcessingError("PROCESSING_UNAVAILABLE");
    }

    this.active += 1;

    try {
      return await this.connect(userId, link, urlHash, startedAt);
    } finally {
      this.active -= 1;
    }
  }

  private parse(url: string): ExternalUrl {
    try {
      return parseExternalUrl(url);
    } catch (error) {
      if (error instanceof InvalidUrlError && error.reason !== "malformed") {
        this.recordBlocked(error.reason);
      } else if (error instanceof UrlNotAllowedError) {
        this.recordBlocked("address");
        this.telemetry.recordRejected("url", lower("URL_NOT_ALLOWED"), 0);
      }

      throw error;
    }
  }

  private recordBlocked(reason: "scheme" | "port" | "credentials" | "address" | "redirect"): void {
    this.telemetry.recordUrlFetch({ outcome: "blocked", reason, durationSeconds: 0, sizeBytes: 0 });
  }

  private async connect(
    userId: string,
    link: ExternalUrl,
    urlHash: string,
    startedAt: number,
  ): Promise<ConnectUrlResult> {
    const page = await this.fetchPage(link, startedAt);
    const content = await this.extract(page, startedAt);
    const text = content.sections.map((section) => section.text).join("\n\n");

    if (text.trim() === "") {
      throw this.rejected(new ConnectionProcessingError("NO_EXTRACTABLE_TEXT"), startedAt);
    }

    const contentHash = this.hasher.sha256(TEXT.encode(text));
    const sameContent = await this.repository.findByContentHash(userId, contentHash);

    if (sameContent !== null) {
      const answer = await this.settle(userId, sameContent);

      if (answer !== null) {
        return this.deduplicated(answer, startedAt);
      }
    }

    const inserted = await this.repository.insertProcessing(userId, {
      kind: "url",
      name: sanitizeDisplayName(content.title ?? "", link.displayName),
      sizeBytes: page.bytes.byteLength,
      contentHash,
      urlHash,
    });

    if (!inserted.created) {
      // Another request connected the same link or text between our lookup and our insert.
      const answer = await this.settle(userId, inserted.connection);

      if (answer === null) {
        throw new ConnectionProcessingError("PROCESSING_UNAVAILABLE");
      }

      return this.deduplicated(answer, startedAt);
    }

    this.processor.enqueue({
      userId,
      connection: inserted.connection,
      bytes: new Uint8Array(0),
      sections: content.sections,
      clearFirst: false,
    });

    return { connection: inserted.connection, deduplicated: false };
  }

  private async fetchPage(link: ExternalUrl, startedAt: number): Promise<FetchedPage> {
    const fetchStartedAt = performance.now();

    try {
      const page = await this.fetcher.fetch(link);

      this.telemetry.recordUrlFetch({
        outcome: "success",
        reason: "none",
        durationSeconds: (performance.now() - fetchStartedAt) / 1000,
        sizeBytes: page.bytes.byteLength,
      });

      return page;
    } catch (error) {
      const code: ConnectionErrorCode =
        error instanceof UrlFetchError ? error.code : "FETCH_FAILED";

      this.telemetry.recordUrlFetch({
        outcome:
          error instanceof UrlFetchError && error.blockedAt !== undefined ? "blocked" : "failure",
        reason:
          error instanceof UrlFetchError && error.blockedAt !== undefined
            ? error.blockedAt
            : lower(code),
        durationSeconds: (performance.now() - fetchStartedAt) / 1000,
        sizeBytes: 0,
      });

      throw this.rejected(
        error instanceof UrlFetchError ? error : new UrlFetchError("FETCH_FAILED"),
        startedAt,
      );
    }
  }

  private async extract(page: FetchedPage, startedAt: number): Promise<UrlContent> {
    try {
      return await withTimeout(this.extractor.extract(page), this.extractionTimeoutMs);
    } catch (error) {
      throw this.rejected(
        error instanceof ConnectionProcessingError
          ? error
          : new ConnectionProcessingError("PROCESSING_UNAVAILABLE"),
        startedAt,
      );
    }
  }

  /** Counts an ingestion that ended before a connection existed, and gives the error back. */
  private rejected<E extends UrlFetchError | ConnectionProcessingError>(
    error: E,
    startedAt: number,
  ): E {
    this.telemetry.recordRejected("url", lower(error.code), (performance.now() - startedAt) / 1000);

    return error;
  }

  private deduplicated(connection: Connection, startedAt: number): ConnectUrlResult {
    this.telemetry.recordDeduplicated("url", (performance.now() - startedAt) / 1000);

    return { connection, deduplicated: true };
  }

  /**
   * What to do with a connection of the same link or content: `ready` and `processing` are the
   * answer; a `failed` one (or a `processing` one that lost its worker) is removed, vectors first,
   * and `null` says to go on as if it did not exist.
   */
  private async settle(userId: string, found: Connection): Promise<Connection | null> {
    let connection = found;

    if (isStaleProcessing(connection, this.now())) {
      const cutoff = new Date(this.now().getTime() - STALE_PROCESSING_MS);

      connection =
        (await this.repository.failIfStale(
          userId,
          connection.id,
          cutoff,
          "PROCESSING_UNAVAILABLE",
        )) ??
        (await this.repository.findById(userId, connection.id)) ??
        connection;
    }

    if (connection.status !== "failed") {
      return connection;
    }

    try {
      await this.index.deleteByConnection(userId, connection.id);
    } catch {
      throw new ConnectionProcessingError("PROCESSING_UNAVAILABLE");
    }

    const staleBefore = new Date(this.now().getTime() - STALE_PROCESSING_MS);

    if (await this.repository.deleteSettled(userId, connection.id, staleBefore)) {
      return null;
    }

    // Someone else took it in the meantime (a retry, a deletion): the current row is the answer.
    return (await this.repository.findById(userId, connection.id)) ?? connection;
  }
}
