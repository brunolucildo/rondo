import { describe, expect, it, vi } from "vitest";
import { EmbeddingsUnavailableError } from "../domain/knowledge-errors";
import { EMBEDDING_DIMENSIONS } from "../domain/knowledge-rules";
import {
  type EmbeddingsClient,
  OpenAiEmbeddingsGenerator,
  toEmbeddingsError,
} from "./openai-embeddings-generator";

const vector = () => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01);
const vectorsFor = (texts: string[]) => texts.map(vector);
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status} SENTINEL-TEXT`), { status });
const noWait = () => Promise.resolve();

function generatorFor(client: EmbeddingsClient | undefined, timeoutMs?: number) {
  return new OpenAiEmbeddingsGenerator(client, {
    wait: noWait,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe("OpenAiEmbeddingsGenerator", () => {
  it("sends 200 texts in 3 calls of at most 96 and keeps the order (R6)", async () => {
    const calls: number[] = [];
    const client: EmbeddingsClient = {
      embedDocuments: (texts) => {
        calls.push(texts.length);

        return Promise.resolve(
          texts.map((text) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => Number(text))),
        );
      },
    };
    const texts = Array.from({ length: 200 }, (_, index) => String(index));

    const vectors = await generatorFor(client).embedDocuments(texts);

    expect(calls).toEqual([96, 96, 8]);
    expect(vectors).toHaveLength(200);
    expect(vectors.map((row) => row[0])).toEqual(texts.map(Number));
  });

  it("makes no call for an empty list", async () => {
    const embedDocuments = vi.fn();

    await expect(generatorFor({ embedDocuments }).embedDocuments([])).resolves.toEqual([]);
    expect(embedDocuments).not.toHaveBeenCalled();
  });

  it("succeeds on the third try after two 429 answers (R6)", async () => {
    const embedDocuments = vi
      .fn<EmbeddingsClient["embedDocuments"]>()
      .mockRejectedValueOnce(httpError(429))
      .mockRejectedValueOnce(httpError(429))
      .mockImplementationOnce((texts) => Promise.resolve(vectorsFor(texts)));

    await expect(generatorFor({ embedDocuments }).embedDocuments(["a", "b"])).resolves.toHaveLength(
      2,
    );
    expect(embedDocuments).toHaveBeenCalledTimes(3);
  });

  it("gives up with EmbeddingsUnavailableError after 3 tries on 429 (R6)", async () => {
    const embedDocuments = vi
      .fn<EmbeddingsClient["embedDocuments"]>()
      .mockRejectedValue(httpError(429));

    const error = await generatorFor({ embedDocuments })
      .embedDocuments(["a"])
      .catch((caught: unknown) => caught);

    expect(embedDocuments).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(EmbeddingsUnavailableError);
    expect(error).toMatchObject({ code: "RATE_LIMITED", attempts: 3 });
    expect((error as Error).message).not.toContain("SENTINEL-TEXT");
  });

  it("retries 5xx but not other 4xx answers", async () => {
    const serverError = vi
      .fn<EmbeddingsClient["embedDocuments"]>()
      .mockRejectedValue(httpError(503));
    const badKey = vi.fn<EmbeddingsClient["embedDocuments"]>().mockRejectedValue(httpError(401));

    await expect(
      generatorFor({ embedDocuments: serverError }).embedDocuments(["a"]),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      attempts: 3,
    });
    await expect(
      generatorFor({ embedDocuments: badKey }).embedDocuments(["a"]),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      attempts: 1,
    });
    expect(serverError).toHaveBeenCalledTimes(3);
    expect(badKey).toHaveBeenCalledTimes(1);
  });

  it("times out a call that never answers and tries again", async () => {
    const embedDocuments = vi
      .fn<EmbeddingsClient["embedDocuments"]>()
      .mockImplementation(() => new Promise<number[][]>(() => undefined));

    await expect(generatorFor({ embedDocuments }, 15).embedDocuments(["a"])).rejects.toMatchObject({
      code: "TIMEOUT",
      attempts: 3,
    });
    expect(embedDocuments).toHaveBeenCalledTimes(3);
  });

  it("rejects an answer with the wrong number of vectors or the wrong dimension, without retrying", async () => {
    const short = vi.fn<EmbeddingsClient["embedDocuments"]>().mockResolvedValue([vector()]);
    const narrow = vi.fn<EmbeddingsClient["embedDocuments"]>().mockResolvedValue([[1, 2, 3]]);

    await expect(
      generatorFor({ embedDocuments: short }).embedDocuments(["a", "b"]),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      attempts: 1,
    });
    await expect(
      generatorFor({ embedDocuments: narrow }).embedDocuments(["a"]),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      attempts: 1,
    });
  });

  it("fails typed, without any call, when there is no OPENAI_API_KEY (R6)", async () => {
    const generator = generatorFor(undefined);

    await expect(generator.embedDocuments(["a"])).rejects.toMatchObject({
      name: "EmbeddingsUnavailableError",
      code: "NOT_CONFIGURED",
      retryable: false,
    });
    await expect(generator.embedQuery("a")).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("embeds a single query text", async () => {
    const embedDocuments = vi
      .fn<EmbeddingsClient["embedDocuments"]>()
      .mockImplementation((texts) => Promise.resolve(vectorsFor(texts)));

    const result = await generatorFor({ embedDocuments }).embedQuery("question");

    expect(result).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(embedDocuments).toHaveBeenCalledWith(["question"]);
  });
});

describe("toEmbeddingsError", () => {
  it("treats a failure with no HTTP status as a retryable provider error", () => {
    expect(toEmbeddingsError(new Error("socket hang up"))).toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: true,
    });
    expect(
      toEmbeddingsError(Object.assign(new Error("x"), { name: "APIConnectionTimeoutError" })),
    ).toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
  });
});
