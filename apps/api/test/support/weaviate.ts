import weaviate, { ApiKey } from "weaviate-client";

/**
 * The development Weaviate of `docker-compose.yml` (public dev key, 127.0.0.1 only). Tests use it
 * unless the environment already provides `WEAVIATE_URL` and `WEAVIATE_API_KEY`.
 */
export const LOCAL_WEAVIATE_URL = "http://localhost:8080";
export const LOCAL_WEAVIATE_API_KEY = "rondo-dev-weaviate-key";

/**
 * Collection the tests write to. It is not the product collection (`KnowledgeChunk`), so a test
 * run never touches indexed data of a developer's own session.
 */
export const TEST_COLLECTION = "KnowledgeChunkTest";

export function weaviateTestConfig() {
  return {
    weaviateUrl: new URL(process.env.WEAVIATE_URL ?? LOCAL_WEAVIATE_URL),
    weaviateGrpcPort: Number(process.env.WEAVIATE_GRPC_PORT ?? 50051),
    weaviateApiKey: process.env.WEAVIATE_API_KEY ?? LOCAL_WEAVIATE_API_KEY,
  };
}

/**
 * Only the tests of the `knowledge` module need Weaviate: the global setup stays Postgres-only so
 * every other integration test keeps running when Weaviate is down. Called from their `beforeAll`.
 */
export async function requireWeaviate(): Promise<void> {
  const { weaviateUrl: url, weaviateGrpcPort, weaviateApiKey } = weaviateTestConfig();

  try {
    const client = await weaviate.connectToCustom({
      httpHost: url.hostname,
      httpPort: Number(url.port) || 80,
      httpSecure: url.protocol === "https:",
      grpcHost: url.hostname,
      grpcPort: weaviateGrpcPort,
      grpcSecure: url.protocol === "https:",
      authCredentials: new ApiKey(weaviateApiKey),
      timeout: { init: 3, query: 3, insert: 3 },
    });

    client.close();
  } catch {
    throw new Error(
      "Could not reach the local Weaviate with WEAVIATE_URL and WEAVIATE_API_KEY. Run " +
        "`bun run infra:up` from the repository root (the knowledge tests are the only ones that need it).",
    );
  }
}
