import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { NodeHttpTransport } from "./node-http-transport";

// These tests exercise the transport alone, against a server on the loopback: it sits below the
// protection (`ProtectedUrlFetcher`), which is what refuses internal addresses.
let server: Server | undefined;
const seen: { host: string | undefined; path: string | undefined; agent: string | undefined }[] =
  [];

async function listen(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<number> {
  server = createServer((request, response) => {
    seen.push({
      host: request.headers.host,
      path: request.url,
      agent: request.headers["user-agent"],
    });
    handle(request, response);
  });

  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));

  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  seen.length = 0;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const transport = new NodeHttpTransport();
const HEADERS = { "user-agent": "test-agent", "accept-encoding": "gzip, deflate, br" };

async function read(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

describe("NodeHttpTransport (R3)", () => {
  it("connects to the given address, whatever the name says, and keeps the name in Host", async () => {
    const port = await listen((_request, response) => {
      response.setHeader("content-type", "text/plain");
      response.end("hello");
    });
    const result = await transport.request({
      url: new URL(`http://does-not-resolve.invalid:${port}/a/b?x=1`),
      address: "127.0.0.1",
      family: 4,
      headers: HEADERS,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("text/plain");
    expect(await read(result.body)).toBe("hello");
    expect(seen).toEqual([
      { host: `does-not-resolve.invalid:${port}`, path: "/a/b?x=1", agent: "test-agent" },
    ]);
  });

  it("does not follow a redirect: it reports the status and the Location", async () => {
    const port = await listen((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", "http://169.254.169.254/");
      response.end();
    });
    const result = await transport.request({
      url: new URL(`http://site.invalid:${port}/`),
      address: "127.0.0.1",
      family: 4,
      headers: HEADERS,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe("http://169.254.169.254/");
    expect(seen).toHaveLength(1);
    result.close();
  });

  it.each([
    ["gzip", (text: string) => gzipSync(text)],
    ["deflate", (text: string) => deflateSync(text)],
    ["br", (text: string) => brotliCompressSync(text)],
  ])("decompresses %s", async (encoding, compress) => {
    const port = await listen((_request, response) => {
      response.setHeader("content-encoding", encoding);
      response.end(compress("compressed text"));
    });
    const result = await transport.request({
      url: new URL(`http://site.invalid:${port}/`),
      address: "127.0.0.1",
      family: 4,
      headers: HEADERS,
      signal: new AbortController().signal,
    });

    expect(await read(result.body)).toBe("compressed text");
  });

  it("rejects an encoding it does not know", async () => {
    const port = await listen((_request, response) => {
      response.setHeader("content-encoding", "compress");
      response.end("x");
    });

    await expect(
      transport.request({
        url: new URL(`http://site.invalid:${port}/`),
        address: "127.0.0.1",
        family: 4,
        headers: HEADERS,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Unsupported content encoding.");
  });

  it("expands a compressed body only as fast as it is read, and close stops it", async () => {
    const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024, 97));
    const port = await listen((_request, response) => {
      response.setHeader("content-encoding", "gzip");
      response.end(bomb);
    });
    const result = await transport.request({
      url: new URL(`http://site.invalid:${port}/`),
      address: "127.0.0.1",
      family: 4,
      headers: HEADERS,
      signal: new AbortController().signal,
    });
    let read = 0;

    for await (const chunk of result.body) {
      read += chunk.byteLength;

      if (read > 1024 * 1024) {
        break;
      }
    }

    result.close();

    expect(read).toBeGreaterThan(1024 * 1024);
    expect(read).toBeLessThan(50 * 1024 * 1024);
  });

  it("aborts with the signal while waiting for the answer", async () => {
    const port = await listen(() => {
      // Never answers.
    });
    const controller = new AbortController();
    const pending = transport.request({
      url: new URL(`http://site.invalid:${port}/`),
      address: "127.0.0.1",
      family: 4,
      headers: HEADERS,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toThrow();
  });

  it("rejects when nothing listens at the address", async () => {
    const port = await listen(() => undefined);

    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    await expect(
      transport.request({
        url: new URL(`http://site.invalid:${port}/`),
        address: "127.0.0.1",
        family: 4,
        headers: HEADERS,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });
});
