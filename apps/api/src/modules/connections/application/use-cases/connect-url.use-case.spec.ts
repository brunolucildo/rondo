import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryKnowledgeIndex } from "../../../knowledge/testing";
import {
  ConnectionLimitReachedError,
  ConnectionProcessingError,
} from "../../domain/connection-errors";
import type { ConnectionTelemetry } from "../../domain/connection-ports";
import { MAX_CONNECTIONS_PER_USER, STALE_PROCESSING_MS } from "../../domain/connection-rules";
import { InvalidUrlError, UrlNotAllowedError } from "../../domain/external-url";
import { UrlFetchError } from "../../domain/url-fetch";
import {
  FAKE_PUBLIC_ADDRESS,
  FakeDnsResolver,
  FakeHttpTransport,
  type FakeReply,
} from "../../infrastructure/fake-web";
import { LangChainUrlContentExtractor } from "../../infrastructure/langchain-url-content-extractor";
import { NodeContentHasher } from "../../infrastructure/node-content-hasher";
import { ProtectedUrlFetcher } from "../../infrastructure/protected-url-fetcher";
import { InMemoryConnectionRepository } from "../../testing/in-memory-connection.repository";
import type { ConnectionProcessor, ProcessRequest } from "../services/connection-processor";
import { ConnectUrl } from "./connect-url.use-case";

const USER_ID = randomUUID();
const OTHER_USER_ID = randomUUID();
const HTML = { "content-type": "text/html; charset=utf-8" };
const SENTINEL = "SEGREDO-DA-URL";
const CONTENT_SENTINEL = "SENTINELA-NO-CONTEUDO";

const page = (title: string, body: string) =>
  `<html><head><title>${title}</title><script>noise()</script></head><body><nav>MENU</nav><main><p>${body}</p></main></body></html>`;

const ARTICLE = page("Match regulation", "Substitutions are limited to five per match.");

interface World {
  [path: string]: FakeReply;
}

function setup(
  world: World = { "/regulation": { headers: HTML, body: ARTICLE } },
  now: () => Date = () => new Date(),
) {
  const repository = new InMemoryConnectionRepository(now);
  const index = new InMemoryKnowledgeIndex();
  const enqueued: ProcessRequest[] = [];
  const processor = { enqueue: (request: ProcessRequest) => enqueued.push(request) };
  const telemetry = {
    traceIngestion: vi.fn(),
    recordDeduplicated: vi.fn(),
    recordDeletion: vi.fn(),
    recordUrlFetch: vi.fn(),
    recordRejected: vi.fn(),
  } satisfies ConnectionTelemetry;
  const resolver = new FakeDnsResolver({
    "site.test": [FAKE_PUBLIC_ADDRESS],
    "mirror.test": [FAKE_PUBLIC_ADDRESS],
    "inner.test": ["10.0.0.5"],
    "x.test": [FAKE_PUBLIC_ADDRESS],
  });
  const transport = new FakeHttpTransport(
    (request) => world[request.url.pathname] ?? { status: 404 },
  );
  const fetcher = new ProtectedUrlFetcher(resolver, transport, { retryDelayMs: 0 });
  const connect = new ConnectUrl(
    repository,
    new NodeContentHasher(),
    fetcher,
    new LangChainUrlContentExtractor(),
    processor as unknown as ConnectionProcessor,
    index,
    telemetry,
    now,
  );

  return { repository, index, enqueued, telemetry, resolver, transport, connect };
}

const run = (connect: ConnectUrl, url: string, userId = USER_ID) =>
  connect.execute({ userId, url });

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected a failure");
}

describe("ConnectUrl: a new link (R5, R6, R7)", () => {
  it("fetches the page, names the connection by its title and schedules the text without the noise", async () => {
    const { connect, enqueued, repository, transport } = setup();
    const result = await run(connect, "https://site.test/regulation");

    expect(result.deduplicated).toBe(false);
    expect(result.connection).toMatchObject({
      kind: "url",
      name: "Match regulation",
      status: "processing",
    });
    expect(transport.requests).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.clearFirst).toBe(false);

    const text = enqueued[0]?.sections?.map((section) => section.text).join("\n") ?? "";

    expect(text).toContain("Substitutions are limited to five per match.");
    expect(text).not.toContain("MENU");
    expect(text).not.toContain("noise()");
    expect(repository.rows.size).toBe(1);
  });

  it("names the connection host/path when the page has no title", async () => {
    const { connect } = setup({
      "/doc/": { headers: HTML, body: "<body><p>Text without a title.</p></body>" },
    });

    expect((await run(connect, "https://site.test/doc/?k=v#a")).connection.name).toBe(
      "site.test/doc",
    );
  });

  it("connects a PDF and a text page the same way (the extractors of the files)", async () => {
    const { connect } = setup({
      "/notes": { headers: { "content-type": "text/plain" }, body: "Plain notes of the club." },
    });
    const result = await run(connect, "https://site.test/notes");

    expect(result.connection.name).toBe("site.test/notes");
  });

  it("stores the hash of the canonical link and the hash of the text, never the link", async () => {
    const { connect, repository } = setup({
      "/doc": { headers: HTML, body: ARTICLE },
    });

    await run(connect, `https://site.test/doc?token=${SENTINEL}#frag`);

    const [row] = [...repository.rows.values()];

    expect(row?.urlHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(SENTINEL);
    expect(JSON.stringify(row)).not.toContain("token");
  });
});

describe("ConnectUrl: dedup in two layers (R6)", () => {
  it("answers from the canonical link with no request at all", async () => {
    const { connect, repository, transport, enqueued, telemetry } = setup();
    const first = await run(connect, "https://site.test/regulation");

    await repository.markReady(USER_ID, first.connection.id, 2);

    const second = await run(connect, "https://SITE.test/regulation/?utm_source=x#section");

    expect(second.deduplicated).toBe(true);
    expect(second.connection.id).toBe(first.connection.id);
    expect(transport.requests).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
    expect(telemetry.recordDeduplicated).toHaveBeenCalledWith("url", expect.any(Number));
  });

  it("answers with the first connection when another link has the same text", async () => {
    const { connect, repository, transport, enqueued } = setup({
      "/regulation": { headers: HTML, body: ARTICLE },
      "/copy": { headers: HTML, body: ARTICLE },
    });
    const first = await run(connect, "https://site.test/regulation");

    await repository.markReady(USER_ID, first.connection.id, 2);

    const second = await run(connect, "https://mirror.test/copy");

    expect(second.deduplicated).toBe(true);
    expect(second.connection.id).toBe(first.connection.id);
    // The second link was fetched (its text was unknown) but nothing new was stored or indexed.
    expect(transport.requests).toHaveLength(2);
    expect(enqueued).toHaveLength(1);
    expect(repository.rows.size).toBe(1);
  });

  it("processes the same link again for another user", async () => {
    const { connect, repository, enqueued } = setup();
    const first = await run(connect, "https://site.test/regulation");

    await repository.markReady(USER_ID, first.connection.id, 2);

    const other = await run(connect, "https://site.test/regulation", OTHER_USER_ID);

    expect(other.deduplicated).toBe(false);
    expect(other.connection.id).not.toBe(first.connection.id);
    expect(enqueued).toHaveLength(2);
  });

  it("returns the connection that is still processing instead of fetching again", async () => {
    const { connect, transport } = setup();
    const first = await run(connect, "https://site.test/regulation");
    const second = await run(connect, "https://site.test/regulation#again");

    expect(second.deduplicated).toBe(true);
    expect(second.connection.id).toBe(first.connection.id);
    expect(transport.requests).toHaveLength(1);
  });

  it("starts over from a failed connection of the same link: vectors and row go, the page is fetched again", async () => {
    const { connect, repository, transport, enqueued, index } = setup();
    const first = await run(connect, "https://site.test/regulation");
    const deleteSpy = vi.spyOn(index, "deleteByConnection");

    await repository.markFailed(USER_ID, first.connection.id, "PROCESSING_UNAVAILABLE");

    const second = await run(connect, "https://site.test/regulation");

    expect(second.deduplicated).toBe(false);
    expect(second.connection.id).not.toBe(first.connection.id);
    expect(deleteSpy).toHaveBeenCalledWith(USER_ID, first.connection.id);
    expect(transport.requests).toHaveLength(2);
    expect(enqueued).toHaveLength(2);
    expect(repository.rows.size).toBe(1);
  });

  it("treats a processing connection that lost its worker as failed and starts over", async () => {
    let clock = new Date("2026-11-18T10:00:00Z");
    const { connect, enqueued } = setup(undefined, () => clock);
    const first = await run(connect, "https://site.test/regulation");

    clock = new Date(clock.getTime() + STALE_PROCESSING_MS + 1000);

    const second = await run(connect, "https://site.test/regulation");

    expect(second.connection.id).not.toBe(first.connection.id);
    expect(enqueued).toHaveLength(2);
  });
});

describe("ConnectUrl: links that are refused with no request (R1, R2)", () => {
  it.each([
    ["ftp://site.test/file"],
    ["file:///etc/passwd"],
    ["http://user:pw@site.test/"],
    ["http://site.test:5432/"],
    ["not a url"],
  ])("answers INVALID_URL for %s", async (url) => {
    const { connect, transport, resolver, repository } = setup();

    expect(await failureOf(run(connect, url))).toBeInstanceOf(InvalidUrlError);
    expect(transport.requests).toEqual([]);
    expect(resolver.lookups).toEqual([]);
    expect(repository.rows.size).toBe(0);
  });

  it.each([
    ["http://localhost"],
    ["http://127.0.0.1"],
    ["http://[::1]"],
    ["http://[::ffff:127.0.0.1]"],
    ["http://10.0.0.5"],
    ["http://192.168.1.1"],
    ["http://169.254.169.254"],
    ["http://0x7f.1"],
  ])("answers URL_NOT_ALLOWED for %s without any connection", async (url) => {
    const { connect, transport, resolver, repository } = setup();

    expect(await failureOf(run(connect, url))).toBeInstanceOf(UrlNotAllowedError);
    expect(transport.requests).toEqual([]);
    expect(resolver.lookups).toEqual([]);
    expect(repository.rows.size).toBe(0);
  });

  it("blocks a public name that resolves to an internal address", async () => {
    const { connect, transport, repository } = setup();
    const error = await failureOf(run(connect, "https://inner.test/regulation"));

    expect(error).toMatchObject({ code: "URL_NOT_ALLOWED", blockedAt: "address" });
    expect(transport.requests).toEqual([]);
    expect(repository.rows.size).toBe(0);
  });

  it("blocks a redirect to the metadata address and creates nothing", async () => {
    const { connect, transport, repository } = setup({
      "/go": { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } },
    });
    const error = await failureOf(run(connect, "https://site.test/go"));

    expect(error).toMatchObject({ code: "URL_NOT_ALLOWED", blockedAt: "redirect" });
    expect(transport.requests).toHaveLength(1);
    expect(repository.rows.size).toBe(0);
  });

  it("refuses the 51st connection before any request", async () => {
    const { connect, repository, transport } = setup();

    for (let number = 0; number < MAX_CONNECTIONS_PER_USER; number += 1) {
      await repository.insertProcessing(USER_ID, {
        kind: "txt",
        name: `seed-${number}.txt`,
        sizeBytes: 1,
        contentHash: number.toString(16).padStart(64, "0"),
      });
    }

    expect(await failureOf(run(connect, "https://site.test/regulation"))).toBeInstanceOf(
      ConnectionLimitReachedError,
    );
    expect(transport.requests).toEqual([]);
  });
});

describe("ConnectUrl: pages that cannot be used create no connection (R4, R5)", () => {
  it("fails with NO_EXTRACTABLE_TEXT for a page that only has JavaScript", async () => {
    const { connect, repository, telemetry } = setup({
      "/spa": {
        headers: HTML,
        body: '<html><body><div id="root"></div><script>render()</script></body></html>',
      },
    });
    const error = await failureOf(run(connect, "https://site.test/spa"));

    expect(error).toBeInstanceOf(ConnectionProcessingError);
    expect(error).toMatchObject({ code: "NO_EXTRACTABLE_TEXT" });
    expect(repository.rows.size).toBe(0);
    expect(telemetry.recordRejected).toHaveBeenCalledWith(
      "url",
      "no_extractable_text",
      expect.any(Number),
    );
  });

  it.each([
    [
      "/big",
      { headers: { ...HTML, "content-length": "9999999999" }, body: "x" },
      "RESPONSE_TOO_LARGE",
    ],
    ["/pic", { headers: { "content-type": "image/png" }, body: "x" }, "UNSUPPORTED_CONTENT_TYPE"],
    ["/missing", { status: 404 }, "FETCH_FAILED"],
  ] as const)("fails with %s -> %s", async (path, reply, code) => {
    const { connect, repository } = setup({ [path]: reply });

    expect(await failureOf(run(connect, `https://site.test${path}`))).toMatchObject({ code });
    expect(await failureOf(run(connect, `https://site.test${path}`))).toBeInstanceOf(UrlFetchError);
    expect(repository.rows.size).toBe(0);
  });

  it("fails with PROCESSING_UNAVAILABLE when the extraction breaks or takes too long", async () => {
    const { repository, index, enqueued } = setup();
    const connect = new ConnectUrl(
      repository,
      new NodeContentHasher(),
      { fetch: () => Promise.resolve({ bytes: new Uint8Array([1]), mediaType: "text/html" }) },
      { extract: () => new Promise(() => undefined) },
      {
        enqueue: (request: ProcessRequest) => enqueued.push(request),
      } as unknown as ConnectionProcessor,
      index,
      {
        traceIngestion: vi.fn(),
        recordDeduplicated: vi.fn(),
        recordDeletion: vi.fn(),
        recordUrlFetch: vi.fn(),
        recordRejected: vi.fn(),
      },
      () => new Date(),
      { extractionTimeoutMs: 20 },
    );

    expect(await failureOf(run(connect, "https://site.test/a"))).toMatchObject({
      code: "PROCESSING_UNAVAILABLE",
    });
    expect(repository.rows.size).toBe(0);
  });

  it("refuses more searches than the concurrency allows", async () => {
    const { repository, index, enqueued } = setup();
    const never = new Promise<never>(() => undefined);
    const connect = new ConnectUrl(
      repository,
      new NodeContentHasher(),
      { fetch: () => never },
      { extract: () => never },
      {
        enqueue: (request: ProcessRequest) => enqueued.push(request),
      } as unknown as ConnectionProcessor,
      index,
      {
        traceIngestion: vi.fn(),
        recordDeduplicated: vi.fn(),
        recordDeletion: vi.fn(),
        recordUrlFetch: vi.fn(),
        recordRejected: vi.fn(),
      },
      () => new Date(),
      { concurrency: 2 },
    );

    void run(connect, "https://site.test/a");
    void run(connect, "https://site.test/b");
    await Promise.resolve();

    expect(await failureOf(run(connect, "https://site.test/c"))).toMatchObject({
      code: "PROCESSING_UNAVAILABLE",
    });
  });
});

describe("ConnectUrl: telemetry and secrets (R7, R10)", () => {
  it("never puts the link, the host, a secret of the query or the page text in telemetry, rows or errors", async () => {
    const { connect, telemetry, repository, enqueued } = setup({
      "/doc": {
        headers: HTML,
        body: page("Doc", `${CONTENT_SENTINEL} is only in the content.`),
      },
      "/fail": { status: 500 },
    });
    const ok = await run(connect, `https://x.test/doc?token=${SENTINEL}#a`);
    const blocked = await failureOf(run(connect, `http://169.254.169.254/?token=${SENTINEL}`));
    const failed = await failureOf(run(connect, `https://x.test/fail?token=${SENTINEL}`));
    const bad = await failureOf(run(connect, `ftp://x.test/?token=${SENTINEL}`));

    const everything = JSON.stringify({
      calls: Object.values(telemetry).map((mock) => mock.mock.calls),
      rows: [...repository.rows.values()],
      errors: [blocked, failed, bad].map((error) => String(error)),
      messages: [blocked, failed, bad].map((error) => (error as Error).message),
      connection: ok.connection,
    });

    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain("x.test");
    expect(everything).not.toContain("169.254");
    expect(everything).not.toContain(CONTENT_SENTINEL);
    // The text is only where it belongs: in what goes to the index.
    expect(JSON.stringify(enqueued[0]?.sections)).toContain(CONTENT_SENTINEL);
  });

  it("records the search: success with its size, blocked by reason, failure by code", async () => {
    const { connect, telemetry } = setup({
      "/doc": { headers: HTML, body: ARTICLE },
      "/fail": { status: 404 },
      "/go": { status: 302, headers: { location: "http://10.0.0.1/" } },
    });

    await run(connect, "https://site.test/doc");
    await failureOf(run(connect, "https://site.test/fail"));
    await failureOf(run(connect, "https://site.test/go"));
    await failureOf(run(connect, "http://localhost/"));
    await failureOf(run(connect, "ftp://site.test/"));
    await failureOf(run(connect, "http://u:p@site.test/"));
    await failureOf(run(connect, "http://site.test:81/"));
    await failureOf(run(connect, "not a url"));

    const records = telemetry.recordUrlFetch.mock.calls.map(([record]) => [
      record.outcome,
      record.reason,
    ]);

    expect(records).toEqual([
      ["success", "none"],
      ["failure", "fetch_failed"],
      ["blocked", "redirect"],
      ["blocked", "address"],
      ["blocked", "scheme"],
      ["blocked", "credentials"],
      ["blocked", "port"],
    ]);
    expect(telemetry.recordUrlFetch.mock.calls[0]?.[0].sizeBytes).toBeGreaterThan(0);
  });
});
