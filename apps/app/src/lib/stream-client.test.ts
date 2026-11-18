import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client";
import type { SseMessage } from "./sse";
import { createStreamClient, isAbortError, type StreamClientOptions } from "./stream-client";

const BASE_URL = "http://api.test/api/v1";

function sseResponse(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }

      controller.close();
    },
  });

  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function errorResponse(status: number, code: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message: "Server message.", details: [] } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

async function collect(stream: AsyncGenerator<SseMessage>): Promise<SseMessage[]> {
  const messages: SseMessage[] = [];

  for await (const message of stream) {
    messages.push(message);
  }

  return messages;
}

function clientWith(fetcher: typeof fetch, options: Partial<StreamClientOptions> = {}) {
  return createStreamClient({ baseUrl: BASE_URL, fetch: fetcher, ...options });
}

describe("stream client", () => {
  it("posts JSON with the bearer token and yields the events of the answer", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sseResponse('event: delta\ndata: {"text":"Oi"}\n\n', "event: done\ndata: {}\n\n"),
      );
    const client = clientWith(fetcher, { getToken: () => "token-1" });

    const messages = await collect(client.post("/experts/head-coach/messages", { content: "Oi" }));

    expect(messages).toEqual([
      { event: "delta", data: { text: "Oi" } },
      { event: "done", data: {} },
    ]);
    expect(fetcher).toHaveBeenCalledWith(`${BASE_URL}/experts/head-coach/messages`, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        authorization: "Bearer token-1",
      },
      body: JSON.stringify({ content: "Oi" }),
      signal: undefined,
    });
  });

  it("sends no Authorization header without a token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sseResponse());

    await collect(clientWith(fetcher).post("/x", {}));

    const [, init] = fetcher.mock.calls[0] ?? [];

    expect(init?.headers).not.toHaveProperty("authorization");
  });

  it("throws the typed ApiError of an error response, before any event", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(errorResponse(503, "EXPERT_UNAVAILABLE"));

    const failure = await collect(clientWith(fetcher).post("/x", {})).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 503, code: "EXPERT_UNAVAILABLE" });
  });

  it("calls onUnauthenticated on a 401 UNAUTHENTICATED and still throws", async () => {
    const onUnauthenticated = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(401, "UNAUTHENTICATED"));

    const failure = await collect(clientWith(fetcher, { onUnauthenticated }).post("/x", {})).catch(
      (error: unknown) => error,
    );

    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(failure).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("does not call onUnauthenticated for other errors", async () => {
    const onUnauthenticated = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(429, "RATE_LIMITED"));

    await collect(clientWith(fetcher, { onUnauthenticated }).post("/x", {})).catch(() => undefined);

    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  it("reports a network failure before the stream as NETWORK_ERROR with status 0", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));

    const failure = await collect(clientWith(fetcher).post("/x", {})).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });

  it("reports a connection cut during the stream as NETWORK_ERROR", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"a"}\n\n'));
        controller.error(new TypeError("network error"));
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
    const seen: SseMessage[] = [];

    const failure = await (async () => {
      for await (const message of clientWith(fetcher).post("/x", {})) {
        seen.push(message);
      }
    })().catch((error: unknown) => error);

    expect(failure).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });

  it("passes the signal on and rethrows the abort as it is", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const pending = collect(clientWith(fetcher).post("/x", {}, { signal: controller.signal }));

    controller.abort();

    const failure = await pending.catch((error: unknown) => error);

    expect(isAbortError(failure)).toBe(true);
  });

  it("removes trailing slashes of the base URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sseResponse());

    await collect(clientWith(fetcher, { baseUrl: `${BASE_URL}//` }).post("/x", {}));

    expect(fetcher.mock.calls[0]?.[0]).toBe(`${BASE_URL}/x`);
  });
});
