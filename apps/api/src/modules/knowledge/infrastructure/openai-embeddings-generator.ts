import { OpenAIEmbeddings } from "@langchain/openai";
import type { EmbeddingsGenerator } from "../domain/embeddings-generator";
import { EmbeddingsUnavailableError } from "../domain/knowledge-errors";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDINGS_BATCH_SIZE,
} from "../domain/knowledge-rules";
import { type RetryPolicy, withRetry, withTimeout } from "./retry";

export const EMBEDDINGS_TIMEOUT_MS = 20_000;
export const EMBEDDINGS_RETRY: RetryPolicy = { attempts: 3, backoffMs: [500, 1_000] };

/** The one call the generator needs from a provider client; tests replace it with a fake. */
export interface EmbeddingsClient {
  embedDocuments(texts: string[]): Promise<number[][]>;
}

export interface OpenAiEmbeddingsOptions {
  timeoutMs?: number;
  retry?: RetryPolicy;
  wait?: (ms: number) => Promise<void>;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const { status } = error as { status?: unknown };

    return typeof status === "number" ? status : undefined;
  }

  return undefined;
}

/**
 * Maps whatever the provider client threw to the typed error. Nothing of the original message is
 * kept: provider errors can echo the request, and the request is the text being embedded.
 */
export function toEmbeddingsError(error: unknown): EmbeddingsUnavailableError {
  if (error instanceof EmbeddingsUnavailableError) {
    return error;
  }

  const status = statusOf(error);
  const name = error instanceof Error ? error.name : "";

  if (status === 429) {
    return new EmbeddingsUnavailableError("RATE_LIMITED", true);
  }

  if (status === 408 || /timeout/i.test(name)) {
    return new EmbeddingsUnavailableError("TIMEOUT", true);
  }

  if (status !== undefined && status >= 500) {
    return new EmbeddingsUnavailableError("PROVIDER_ERROR", true);
  }

  if (status === undefined) {
    // No HTTP status: the request never got an answer (connection reset, DNS...).
    return new EmbeddingsUnavailableError("PROVIDER_ERROR", true);
  }

  // 4xx other than 408 and 429 (bad key, bad request): another try cannot help.
  return new EmbeddingsUnavailableError("PROVIDER_ERROR", false);
}

export function createOpenAiEmbeddingsClient(
  apiKey: string,
  timeoutMs = EMBEDDINGS_TIMEOUT_MS,
): EmbeddingsClient {
  const embeddings = new OpenAIEmbeddings({
    apiKey,
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    batchSize: EMBEDDINGS_BATCH_SIZE,
    stripNewLines: false,
    timeout: timeoutMs,
    // Retries are ours (bounded, growing wait, typed error); the client must not add its own.
    maxRetries: 0,
  });

  return { embedDocuments: (texts) => embeddings.embedDocuments(texts) };
}

/**
 * `EmbeddingsGenerator` over OpenAI `text-embedding-3-small`: up to 96 texts per call, calls one
 * after the other, 20 s per call and up to 3 tries on 429, 5xx and timeouts. Without a client (no
 * `OPENAI_API_KEY`) it fails typed before touching the network. Never logs a text.
 */
export class OpenAiEmbeddingsGenerator implements EmbeddingsGenerator {
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly wait: ((ms: number) => Promise<void>) | undefined;

  constructor(
    private readonly client: EmbeddingsClient | undefined,
    options: OpenAiEmbeddingsOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? EMBEDDINGS_TIMEOUT_MS;
    this.retry = options.retry ?? EMBEDDINGS_RETRY;
    this.wait = options.wait;
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    const vectors: number[][] = [];

    for (let start = 0; start < texts.length; start += EMBEDDINGS_BATCH_SIZE) {
      vectors.push(...(await this.embedBatch(texts.slice(start, start + EMBEDDINGS_BATCH_SIZE))));
    }

    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);

    if (vector === undefined) {
      throw new EmbeddingsUnavailableError("PROVIDER_ERROR", false);
    }

    return vector;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    const { client } = this;

    if (client === undefined) {
      throw new EmbeddingsUnavailableError("NOT_CONFIGURED", false);
    }

    return withRetry(
      async () => {
        const vectors = await withTimeout(
          client.embedDocuments(batch),
          this.timeoutMs,
          () => new EmbeddingsUnavailableError("TIMEOUT", true),
        );

        if (
          vectors.length !== batch.length ||
          vectors.some((vector) => vector.length !== EMBEDDING_DIMENSIONS)
        ) {
          throw new EmbeddingsUnavailableError("PROVIDER_ERROR", false);
        }

        return vectors;
      },
      toEmbeddingsError,
      this.retry,
      this.wait,
    );
  }
}
