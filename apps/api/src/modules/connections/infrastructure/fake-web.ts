import { gzipSync } from "node:zlib";
import type {
  DnsResolver,
  HttpTransport,
  TransportRequest,
  TransportResponse,
} from "../domain/url-fetch";

/** A public address for the fake names (the documentation ranges are refused by the guard). */
export const FAKE_PUBLIC_ADDRESS = "93.184.216.34";

/** What a scripted page answers. */
export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Sends the body in chunks of this many bytes (default: one chunk). */
  chunkSize?: number;
}

/** Resolver in memory: a name maps to its addresses; anything else does not resolve. */
export class FakeDnsResolver implements DnsResolver {
  readonly lookups: string[] = [];

  constructor(private readonly table: Readonly<Record<string, readonly string[]>> = {}) {}

  resolve(hostname: string): Promise<string[]> {
    this.lookups.push(hostname);

    const addresses = this.table[hostname];

    return addresses === undefined
      ? Promise.reject(new Error("ENOTFOUND"))
      : Promise.resolve([...addresses]);
  }
}

function toBytes(body: string | Uint8Array | undefined): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : (body ?? new Uint8Array(0));
}

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

export interface RecordedRequest {
  url: string;
  address: string;
}

/** Transport in memory: `handle` answers each request; every request is recorded (URL and address). */
export class FakeHttpTransport implements HttpTransport {
  readonly requests: RecordedRequest[] = [];
  /** Bytes the body iterator actually produced, to prove that a large body is not read to the end. */
  produced = 0;

  constructor(
    private readonly handle: (request: TransportRequest) => FakeReply | Promise<FakeReply>,
  ) {}

  async request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push({ url: request.url.href, address: request.address });

    const reply = await this.handle(request);
    const bytes = toBytes(reply.body);
    const state = { closed: false };

    return {
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
      body: this.stream(bytes, reply.chunkSize ?? Math.max(bytes.byteLength, 1), state),
      close: () => {
        state.closed = true;
      },
    };
  }

  private async *stream(
    bytes: Uint8Array,
    size: number,
    state: { closed: boolean },
  ): AsyncGenerator<Uint8Array> {
    for await (const chunk of chunked(bytes, size)) {
      if (state.closed) {
        return;
      }

      this.produced += chunk.byteLength;
      yield chunk;
    }
  }
}

/** A gzip body, for the decompression limit. */
export const gzipped = (body: string | Uint8Array): Uint8Array => gzipSync(toBytes(body));

const ARTICLE = `<!doctype html>
<html lang="en"><head><title>Match regulation 2026</title>
<style>.menu { color: red }</style><script>window.secretAnalytics = "SCRIPT-NOISE";</script></head>
<body><nav><a href="/">Home</a> <a href="/rules">MENU-NOISE</a></nav>
<main><article><h1>Match regulation 2026</h1>
<p>Substitutions are limited to five per match, and each club may register twenty-three players for every round of the competition.</p>
<p>The disciplinary committee reviews every red card within seventy-two hours and publishes its decision on the official bulletin.</p></article></main>
<footer>FOOTER-NOISE all rights reserved</footer></body></html>`;

const SCRIPT_ONLY = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script>render()</script></body></html>`;

/**
 * The small web the API sees when `NODE_ENV=test` (E2E and integration): a resolver and a
 * transport in memory, below the real protection (`ProtectedUrlFetcher`), which therefore still
 * refuses `localhost`, private and metadata addresses. No request leaves the machine.
 */
export function createScriptedWeb(): { resolver: DnsResolver; transport: HttpTransport } {
  const resolver = new FakeDnsResolver({
    "docs.example.test": [FAKE_PUBLIC_ADDRESS],
    "mirror.example.test": [FAKE_PUBLIC_ADDRESS],
    "internal.example.test": ["10.0.0.5"],
  });
  const transport = new FakeHttpTransport((request): FakeReply => {
    const path = request.url.pathname;
    const html = { "content-type": "text/html; charset=utf-8" };

    switch (path) {
      case "/regulation":
        return { headers: html, body: ARTICLE };
      case "/script-only":
        return { headers: html, body: SCRIPT_ONLY };
      case "/moved":
        return { status: 301, headers: { location: "/regulation" } };
      case "/to-metadata":
        return { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } };
      case "/image":
        return { headers: { "content-type": "image/png" }, body: "png" };
      default:
        return { status: 404, headers: html, body: "not found" };
    }
  });

  return { resolver, transport };
}
