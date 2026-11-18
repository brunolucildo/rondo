export interface KnowledgeConfig {
  /** Weaviate HTTP endpoint, for example `http://localhost:8080`. */
  weaviateUrl: URL;
  /** gRPC port of the same host (default 50051). */
  weaviateGrpcPort: number;
  /** API key of the Weaviate server. Server only: never logged, never in the bundle. */
  weaviateApiKey: string;
  /** OpenAI key for embeddings. Absent is valid: generating embeddings then fails typed, offline. */
  openAiApiKey: string | undefined;
  /** Collection that holds the chunks. */
  collection: string;
}

export const DEFAULT_COLLECTION = "KnowledgeChunk";
const DEFAULT_GRPC_PORT = 50051;
const COLLECTION_NAME = /^[A-Z][A-Za-z0-9_]{0,63}$/;

/**
 * Reads the knowledge settings from the environment. Errors name the variable and never echo a
 * value (a key must not reach a log, not even a malformed one).
 */
export function parseKnowledgeConfig(env: Record<string, string | undefined>): KnowledgeConfig {
  const rawUrl = env.WEAVIATE_URL?.trim();

  if (!rawUrl) {
    throw new Error(
      "WEAVIATE_URL must be set (for example http://localhost:8080). " +
        "Add it to .env (see .env.example) and run `bun run infra:up`.",
    );
  }

  let weaviateUrl: URL;

  try {
    weaviateUrl = new URL(rawUrl);
  } catch {
    throw new Error("WEAVIATE_URL must be an http(s) URL, for example http://localhost:8080.");
  }

  if (weaviateUrl.protocol !== "http:" && weaviateUrl.protocol !== "https:") {
    throw new Error("WEAVIATE_URL must be an http(s) URL, for example http://localhost:8080.");
  }

  const weaviateApiKey = env.WEAVIATE_API_KEY?.trim();

  if (!weaviateApiKey) {
    throw new Error("WEAVIATE_API_KEY must be set. Add it to .env (see .env.example).");
  }

  const rawGrpcPort = env.WEAVIATE_GRPC_PORT?.trim();
  const weaviateGrpcPort = rawGrpcPort ? Number(rawGrpcPort) : DEFAULT_GRPC_PORT;

  if (!Number.isInteger(weaviateGrpcPort) || weaviateGrpcPort < 1 || weaviateGrpcPort > 65535) {
    throw new Error("WEAVIATE_GRPC_PORT must be an integer between 1 and 65535.");
  }

  const collection = env.WEAVIATE_COLLECTION?.trim() || DEFAULT_COLLECTION;

  if (!COLLECTION_NAME.test(collection)) {
    throw new Error(
      "WEAVIATE_COLLECTION must start with a capital letter and use only letters, digits and _.",
    );
  }

  return {
    weaviateUrl,
    weaviateGrpcPort,
    weaviateApiKey,
    openAiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
    collection,
  };
}
