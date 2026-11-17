import { describe, expect, it, vi } from "vitest";
import { createOpenAiImageClient, ImageGenerationError } from "./image-client.ts";

const request = () => ({
  prompt: "a pixel art portrait",
  model: "gpt-image-2",
  size: "1024x1024",
  signal: new AbortController().signal,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function clientWith(fetchImpl: typeof fetch) {
  return createOpenAiImageClient({ apiKey: "test-key", fetchImpl });
}

describe("createOpenAiImageClient", () => {
  it("posts the prompt with the key in the header and decodes the base64 picture", async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, { data: [{ b64_json: Buffer.from([1, 2, 3]).toString("base64") }] }),
    );
    const picture = await clientWith(fetchImpl as unknown as typeof fetch).generate(request());
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

    expect([...picture]).toEqual([1, 2, 3]);
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "gpt-image-2",
      prompt: "a pixel art portrait",
      size: "1024x1024",
      n: 1,
    });
  });

  it("maps a content policy refusal to a blocked, non-retryable failure", async () => {
    const client = clientWith((async () =>
      json(400, {
        error: {
          code: "moderation_blocked",
          message: "Your request was rejected by the safety system.",
        },
      })) as typeof fetch);

    await expect(client.generate(request())).rejects.toMatchObject({
      code: "blocked",
      retryable: false,
    });
  });

  it("marks 429 and 5xx as retryable and other errors as final", async () => {
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [401, false],
      [400, false],
    ] as const) {
      const client = clientWith((async () =>
        json(status, { error: { message: "nope" } })) as typeof fetch);

      await expect(client.generate(request())).rejects.toMatchObject({ code: "api", retryable });
    }
  });

  it("reports a missing picture and a network failure", async () => {
    await expect(
      clientWith((async () => json(200, { data: [] })) as typeof fetch).generate(request()),
    ).rejects.toMatchObject({ code: "invalid_response" });

    await expect(
      clientWith((async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch).generate(request()),
    ).rejects.toMatchObject({ code: "api", retryable: true });
  });

  it("reports a timeout when the signal aborts the request", async () => {
    const controller = new AbortController();
    const client = clientWith(
      ((_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as unknown as typeof fetch,
    );
    const pending = client.generate({ ...request(), signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(ImageGenerationError);
    await expect(pending).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("never puts the key in an error message", async () => {
    const client = clientWith((async () =>
      json(401, { error: { message: "Incorrect API key provided: test-key" } })) as typeof fetch);
    const error = await client.generate(request()).catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(ImageGenerationError);
    expect((error as Error).message).not.toContain("test-key");
    expect((error as Error).message).toContain("[redacted]");
  });
});
