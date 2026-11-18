import { describe, expect, it } from "vitest";
import { parseExternalUrl } from "../domain/external-url";
import { type UrlFetchErrorCode, UrlFetchError } from "../domain/url-fetch";
import {
  FAKE_PUBLIC_ADDRESS,
  FakeDnsResolver,
  FakeHttpTransport,
  type FakeReply,
  gzipped,
} from "./fake-web";
import { ProtectedUrlFetcher } from "./protected-url-fetcher";

const HTML = { "content-type": "text/html; charset=utf-8" };

function setup(
  handle: (url: URL) => FakeReply | Promise<FakeReply>,
  table: Record<string, readonly string[]> = { "site.test": [FAKE_PUBLIC_ADDRESS] },
  options: ConstructorParameters<typeof ProtectedUrlFetcher>[2] = {},
) {
  const resolver = new FakeDnsResolver(table);
  const transport = new FakeHttpTransport((request) => handle(request.url));
  const fetcher = new ProtectedUrlFetcher(resolver, transport, {
    retryDelayMs: 0,
    ...options,
  });

  return { resolver, transport, fetcher };
}

const link = (raw: string) => parseExternalUrl(raw);

/** `/` -> `/hop1` -> `/hop2` -> ... */
const nextHop = (url: URL): string =>
  `/hop${Number(/^\/hop(\d+)$/.exec(url.pathname)?.[1] ?? 0) + 1}`;

async function failureOf(promise: Promise<unknown>): Promise<UrlFetchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UrlFetchError) {
      return error;
    }

    throw error;
  }

  throw new Error("expected the fetch to fail");
}

const codeOf = async (promise: Promise<unknown>): Promise<UrlFetchErrorCode> =>
  (await failureOf(promise)).code;

describe("ProtectedUrlFetcher: the address is validated, then used (R2, R3)", () => {
  it("fetches a public page and connects to the address it validated", async () => {
    const { fetcher, transport, resolver } = setup(() => ({ headers: HTML, body: "<p>hi</p>" }));
    const page = await fetcher.fetch(link("https://site.test/doc"));

    expect(page.mediaType).toBe("text/html");
    expect(page.charset).toBe("utf-8");
    expect(new TextDecoder().decode(page.bytes)).toBe("<p>hi</p>");
    expect(transport.requests).toEqual([
      { url: "https://site.test/doc", address: FAKE_PUBLIC_ADDRESS },
    ]);
    expect(resolver.lookups).toEqual(["site.test"]);
  });

  it("looks the name up once: a rebinding resolver cannot send the connection elsewhere", async () => {
    let calls = 0;
    const resolver = {
      resolve: (): Promise<string[]> => {
        calls += 1;

        return Promise.resolve(calls === 1 ? [FAKE_PUBLIC_ADDRESS] : ["127.0.0.1"]);
      },
    };
    const transport = new FakeHttpTransport(() => ({ headers: HTML, body: "ok" }));
    const fetcher = new ProtectedUrlFetcher(resolver, transport, { retryDelayMs: 0 });

    await fetcher.fetch(link("https://rebind.test/"));

    expect(calls).toBe(1);
    expect(transport.requests.map((request) => request.address)).toEqual([FAKE_PUBLIC_ADDRESS]);
  });

  it.each([
    ["10.0.0.5"],
    ["127.0.0.1"],
    ["169.254.169.254"],
    ["::1"],
    ["fe80::1"],
    ["::ffff:127.0.0.1"],
    ["100.64.0.1"],
  ])("makes no request when the name resolves to %s", async (address) => {
    const { fetcher, transport } = setup(() => ({ headers: HTML, body: "x" }), {
      "evil.test": [address],
    });
    const failure = await failureOf(fetcher.fetch(link("https://evil.test/")));

    expect(failure).toMatchObject({ code: "URL_NOT_ALLOWED", blockedAt: "address" });
    expect(transport.requests).toEqual([]);
  });

  it("refuses the whole name when only one of its addresses is internal", async () => {
    const { fetcher, transport } = setup(() => ({ headers: HTML, body: "x" }), {
      "mixed.test": [FAKE_PUBLIC_ADDRESS, "10.0.0.5"],
    });

    expect(await codeOf(fetcher.fetch(link("https://mixed.test/")))).toBe("URL_NOT_ALLOWED");
    expect(transport.requests).toEqual([]);
  });

  it("does not resolve an address literal and connects to it", async () => {
    const { fetcher, transport, resolver } = setup(() => ({ headers: HTML, body: "x" }));

    await fetcher.fetch(link("https://93.184.216.34/"));

    expect(resolver.lookups).toEqual([]);
    expect(transport.requests[0]?.address).toBe("93.184.216.34");
  });

  it("fails with FETCH_FAILED when the name does not resolve", async () => {
    const { fetcher, transport } = setup(() => ({}), {});

    expect(await codeOf(fetcher.fetch(link("https://nowhere.test/")))).toBe("FETCH_FAILED");
    expect(transport.requests).toEqual([]);
  });
});

describe("ProtectedUrlFetcher: redirects (R3)", () => {
  it("follows a safe redirect, relative or absolute, to the end", async () => {
    const { fetcher, transport } = setup((url) =>
      url.pathname === "/a"
        ? { status: 301, headers: { location: "/b" } }
        : url.pathname === "/b"
          ? { status: 302, headers: { location: "https://site.test/c?x=1" } }
          : { headers: HTML, body: "final" },
    );
    const page = await fetcher.fetch(link("https://site.test/a"));

    expect(new TextDecoder().decode(page.bytes)).toBe("final");
    expect(transport.requests.map((request) => request.url)).toEqual([
      "https://site.test/a",
      "https://site.test/b",
      "https://site.test/c?x=1",
    ]);
  });

  it("allows the upgrade from http to https", async () => {
    const { fetcher } = setup((url) =>
      url.protocol === "http:"
        ? { status: 301, headers: { location: "https://site.test/" } }
        : { headers: HTML, body: "secure" },
    );

    expect((await fetcher.fetch(link("http://site.test/"))).bytes.byteLength).toBe(6);
  });

  it.each([
    ["http://169.254.169.254/latest/meta-data/"],
    ["http://localhost/admin"],
    ["http://[::1]/"],
    ["http://10.0.0.5/"],
    ["ftp://site.test/file"],
    ["file:///etc/passwd"],
    ["https://user:pw@site.test/"],
    ["https://site.test:5432/"],
  ])("refuses a redirect to %s without requesting it", async (location) => {
    const { fetcher, transport } = setup(() => ({ status: 302, headers: { location } }));
    const failure = await failureOf(fetcher.fetch(link("https://site.test/")));

    expect(failure).toMatchObject({ code: "URL_NOT_ALLOWED", blockedAt: "redirect" });
    expect(transport.requests).toHaveLength(1);
  });

  it("refuses a redirect to a name that resolves to an internal address", async () => {
    const { fetcher, transport } = setup(
      () => ({ status: 302, headers: { location: "https://inner.test/" } }),
      { "site.test": [FAKE_PUBLIC_ADDRESS], "inner.test": ["192.168.0.9"] },
    );
    const failure = await failureOf(fetcher.fetch(link("https://site.test/")));

    expect(failure).toMatchObject({ code: "URL_NOT_ALLOWED", blockedAt: "redirect" });
    expect(transport.requests).toHaveLength(1);
  });

  it("gives up after 3 redirects", async () => {
    const { fetcher, transport } = setup((url) => ({
      status: 302,
      headers: { location: nextHop(url) },
    }));

    expect(await codeOf(fetcher.fetch(link("https://site.test/")))).toBe("TOO_MANY_REDIRECTS");
    // The link itself and 3 redirects: 4 requests, the 4th redirect is not followed.
    expect(transport.requests).toHaveLength(4);
  });

  it("follows exactly 3 redirects", async () => {
    const { fetcher } = setup((url) =>
      url.pathname === "/hop3"
        ? { headers: HTML, body: "done" }
        : { status: 302, headers: { location: nextHop(url) } },
    );

    expect((await fetcher.fetch(link("https://site.test/"))).bytes.byteLength).toBe(4);
  });

  it("fails when a redirect has no usable Location", async () => {
    const { fetcher } = setup(() => ({ status: 302 }));

    expect(await codeOf(fetcher.fetch(link("https://site.test/")))).toBe("FETCH_FAILED");
  });
});

describe("ProtectedUrlFetcher: limits (R4)", () => {
  it("stops reading a body that grows past the limit, whatever Content-Length says", async () => {
    const { fetcher, transport } = setup(
      () => ({
        headers: { ...HTML, "content-length": "10" },
        body: "a".repeat(10_000),
        chunkSize: 100,
      }),
      undefined,
      { maxBytes: 1000 },
    );

    expect(await codeOf(fetcher.fetch(link("https://site.test/")))).toBe("RESPONSE_TOO_LARGE");
    expect(transport.produced).toBeLessThanOrEqual(1100);
  });

  it("refuses at once a body that declares more than the limit", async () => {
    const { fetcher, transport } = setup(
      () => ({ headers: { ...HTML, "content-length": "999999" }, body: "small" }),
      undefined,
      { maxBytes: 1000 },
    );

    expect(await codeOf(fetcher.fetch(link("https://site.test/")))).toBe("RESPONSE_TOO_LARGE");
    expect(transport.produced).toBe(0);
  });

  it("accepts a body exactly at the limit", async () => {
    const { fetcher } = setup(() => ({ headers: HTML, body: "a".repeat(1000) }), undefined, {
      maxBytes: 1000,
    });

    expect((await fetcher.fetch(link("https://site.test/"))).bytes.byteLength).toBe(1000);
  });

  it("counts the decompressed bytes against the limit", async () => {
    // The transport hands over decoded bytes: a small compressed body that expands is just a big body.
    const bomb = gzipped("a".repeat(100_000));

    expect(bomb.byteLength).toBeLessThan(1000);

    const { fetcher, transport } = setup(
      () => ({ headers: HTML, body: "a".repeat(100_000), chunkSize: 1000 }),
      undefined,
      { maxBytes: 5000 },
    );

    expect(await codeOf(fetcher.fetch(link("https://site.test/")))).toBe("RESPONSE_TOO_LARGE");
    expect(transport.produced).toBeLessThan(10_000);
  });

  it.each([["image/png"], ["application/zip"], ["application/octet-stream"], ["text/css"]])(
    "refuses %s",
    async (type) => {
      const { fetcher } = setup(() => ({ headers: { "content-type": type }, body: "x" }));

      expect(await codeOf(fetcher.fetch(link("https://site.test/")))).toBe(
        "UNSUPPORTED_CONTENT_TYPE",
      );
    },
  );

  it("refuses a response with no Content-Type", async () => {
    const { fetcher } = setup(() => ({ body: "x" }));

    expect(await codeOf(fetcher.fetch(link("https://site.test/")))).toBe(
      "UNSUPPORTED_CONTENT_TYPE",
    );
  });

  it.each([
    ["text/html", "text/html"],
    ["TEXT/PLAIN; charset=ISO-8859-1", "text/plain"],
    ["text/markdown", "text/markdown"],
    ["application/pdf", "application/pdf"],
  ])("accepts %s", async (header, expected) => {
    const { fetcher } = setup(() => ({ headers: { "content-type": header }, body: "x" }));

    expect((await fetcher.fetch(link("https://site.test/"))).mediaType).toBe(expected);
  });

  it("reports the charset the server named", async () => {
    const { fetcher } = setup(() => ({
      headers: { "content-type": 'text/plain; charset="ISO-8859-1"' },
      body: "x",
    }));

    expect((await fetcher.fetch(link("https://site.test/"))).charset).toBe("iso-8859-1");
  });

  it("gives up with FETCH_TIMEOUT when the server never answers, and does not retry", async () => {
    let requests = 0;
    const resolver = new FakeDnsResolver({ "slow.test": [FAKE_PUBLIC_ADDRESS] });
    const transport = {
      request: (request: { signal: AbortSignal }): Promise<never> => {
        requests += 1;

        return new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    };
    const fetcher = new ProtectedUrlFetcher(resolver, transport, {
      timeoutMs: 20,
      retryDelayMs: 0,
    });

    expect(await codeOf(fetcher.fetch(link("https://slow.test/")))).toBe("FETCH_TIMEOUT");
    expect(requests).toBe(1);
  });

  it("gives up with FETCH_TIMEOUT when the name takes too long to resolve", async () => {
    const resolver = { resolve: (): Promise<string[]> => new Promise(() => undefined) };
    const transport = new FakeHttpTransport(() => ({ headers: HTML, body: "x" }));
    const fetcher = new ProtectedUrlFetcher(resolver, transport, { timeoutMs: 20 });

    expect(await codeOf(fetcher.fetch(link("https://slow-dns.test/")))).toBe("FETCH_TIMEOUT");
    expect(transport.requests).toEqual([]);
  });
});

describe("ProtectedUrlFetcher: attempts (R4)", () => {
  it("tries again after a 503 and succeeds on the second attempt", async () => {
    let calls = 0;
    const { fetcher, transport } = setup(() => {
      calls += 1;

      return calls === 1 ? { status: 503 } : { headers: HTML, body: "ok" };
    });

    expect((await fetcher.fetch(link("https://site.test/"))).bytes.byteLength).toBe(2);
    expect(transport.requests).toHaveLength(2);
  });

  it("tries again after a network failure and gives up after two attempts", async () => {
    let calls = 0;
    const resolver = new FakeDnsResolver({ "down.test": [FAKE_PUBLIC_ADDRESS] });
    const transport = {
      request: (): Promise<never> => {
        calls += 1;

        return Promise.reject(new Error("ECONNRESET"));
      },
    };
    const fetcher = new ProtectedUrlFetcher(resolver, transport, { retryDelayMs: 0 });

    expect(await codeOf(fetcher.fetch(link("https://down.test/")))).toBe("FETCH_FAILED");
    expect(calls).toBe(2);
  });

  it("fails after two 5xx answers", async () => {
    const { fetcher, transport } = setup(() => ({ status: 502 }));

    expect(await codeOf(fetcher.fetch(link("https://site.test/")))).toBe("FETCH_FAILED");
    expect(transport.requests).toHaveLength(2);
  });

  it.each([[400], [401], [403], [404], [410], [429]])(
    "never tries again after a %i",
    async (status) => {
      const { fetcher, transport } = setup(() => ({ status }));

      expect(await codeOf(fetcher.fetch(link("https://site.test/")))).toBe("FETCH_FAILED");
      expect(transport.requests).toHaveLength(1);
    },
  );

  it("uses the next validated address on the second attempt", async () => {
    let calls = 0;
    const { fetcher, transport } = setup(
      () => {
        calls += 1;

        return calls === 1 ? { status: 500 } : { headers: HTML, body: "ok" };
      },
      { "multi.test": ["93.184.216.34", "8.8.4.4"] },
    );

    await fetcher.fetch(link("https://multi.test/"));

    expect(transport.requests.map((request) => request.address)).toEqual([
      "93.184.216.34",
      "8.8.4.4",
    ]);
  });
});

describe("ProtectedUrlFetcher: errors carry no link", () => {
  it("has fixed messages that never contain the host, path or query", async () => {
    const { fetcher } = setup(() => ({ status: 404 }));
    const failure = await failureOf(
      fetcher.fetch(link("https://site.test/private/doc?token=SEGREDO")),
    );

    expect(failure.message).toBe("Link fetch failed: FETCH_FAILED");
    expect(JSON.stringify(failure)).not.toContain("SEGREDO");
    expect(failure.message).not.toContain("site.test");
  });
});
