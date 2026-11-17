import { WeaviateStore } from "@langchain/weaviate";
import weaviate, {
  ApiKey,
  configure,
  generateUuid5,
  type WeaviateClient,
  type DataObject,
} from "weaviate-client";
import type { KnowledgeConfig } from "../domain/knowledge-config";
import { KnowledgeIndexUnavailableError } from "../domain/knowledge-errors";
import type {
  KnowledgeChunk,
  KnowledgeIndex,
  KnowledgeSearchHit,
  KnowledgeSearchOptions,
} from "../domain/knowledge-index";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, tenantNameOf } from "../domain/knowledge-rules";
import {
  assertChunks,
  assertConnectionId,
  assertSearch,
  assertUserId,
} from "../domain/knowledge-validation";
import { isTenantNotFound, toKnowledgeIndexError } from "./weaviate-errors";
import { type RetryPolicy, withRetry, withTimeout } from "./retry";

export const INDEX_TIMEOUT_MS = 10_000;
export const INDEX_RETRY: RetryPolicy = { attempts: 3, backoffMs: [250, 500] };

/** Objects per `insertMany` call. */
const INSERT_BATCH_SIZE = 100;

/** `deleteMany` removes at most the server's query limit per call; this bounds the loop. */
const MAX_DELETE_ROUNDS = 100;

/** Namespace of the UUIDv5 that gives every chunk a stable id (so an upsert replaces it). */
const CHUNK_ID_NAMESPACE = "5d3f6b4e-2c1a-4e8b-9f70-6a1d0c8e7b21";

const TEXT_KEY = "text";
const METADATA_KEYS = ["connectionId", "sourceName", "position", "page"];

/** The store only reads vectors here; asking it to embed anything is a bug. */
const NO_EMBEDDINGS = {
  embedDocuments: () =>
    Promise.reject(new Error("The index never embeds: vectors come from the application.")),
  embedQuery: () =>
    Promise.reject(new Error("The index never embeds: vectors come from the application.")),
};

export type WeaviateConnector = () => Promise<WeaviateClient>;

export interface WeaviateIndexOptions {
  collection: string;
  timeoutMs?: number;
  retry?: RetryPolicy;
  wait?: (ms: number) => Promise<void>;
}

/** Connects with the API key over HTTP and gRPC; the client does its own startup check. */
export function createWeaviateConnector(
  config: Pick<KnowledgeConfig, "weaviateUrl" | "weaviateGrpcPort" | "weaviateApiKey">,
  timeoutMs = INDEX_TIMEOUT_MS,
): WeaviateConnector {
  const { weaviateUrl: url } = config;
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const secure = url.protocol === "https:";

  return () =>
    weaviate.connectToCustom({
      httpHost: url.hostname,
      httpPort: Number(url.port) || (secure ? 443 : 80),
      httpSecure: secure,
      grpcHost: url.hostname,
      grpcPort: config.weaviateGrpcPort,
      grpcSecure: secure,
      authCredentials: new ApiKey(config.weaviateApiKey),
      timeout: { init: seconds, query: seconds, insert: seconds },
    });
}

/**
 * `KnowledgeIndex` over Weaviate with one tenant per user (multi-tenancy): the isolation is the
 * database's, not a filter. Vectors come from the application (the collection has no vectorizer).
 *
 * - **Tenants:** `u_<uuid>` per user, created on the first `upsert` (idempotent). `search` and the
 *   deletes on a user without a tenant do nothing and never create one.
 * - **Reads** go through LangChain's `WeaviateStore`; **writes, tenants and deletes** use the
 *   official client directly (the store's `addVectors` prints payloads to the console and its
 *   `delete` does not report how many objects matched, which the delete loop needs).
 * - **Failures:** every call has a timeout and up to 3 tries with a growing wait; whatever the
 *   client throws becomes a `KnowledgeIndexUnavailableError` with a fixed message.
 */
export class WeaviateKnowledgeIndex implements KnowledgeIndex {
  private clientPromise: Promise<WeaviateClient> | undefined;
  private collectionReady: Promise<void> | undefined;

  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly wait: ((ms: number) => Promise<void>) | undefined;
  private readonly collection: string;

  constructor(
    private readonly connect: WeaviateConnector,
    options: WeaviateIndexOptions,
  ) {
    this.collection = options.collection;
    this.timeoutMs = options.timeoutMs ?? INDEX_TIMEOUT_MS;
    this.retry = options.retry ?? INDEX_RETRY;
    this.wait = options.wait;
  }

  async upsert(userId: string, chunks: readonly KnowledgeChunk[]): Promise<void> {
    assertUserId(userId);
    assertChunks(chunks);

    if (chunks.length === 0) {
      return;
    }

    const tenant = tenantNameOf(userId);

    await this.call(async (client) => {
      const collection = client.collections.get(this.collection);

      await collection.tenants.create([{ name: tenant }]);

      for (let start = 0; start < chunks.length; start += INSERT_BATCH_SIZE) {
        const batch = chunks.slice(start, start + INSERT_BATCH_SIZE).map(toObject);
        const response = await collection.withTenant(tenant).data.insertMany(batch);

        if (response.hasErrors) {
          // Per-object messages can repeat the text or the vector: only their category is kept.
          throw toKnowledgeIndexError(new Error(Object.values(response.errors)[0]?.message ?? ""));
        }
      }
    });
  }

  async search(
    userId: string,
    queryVector: readonly number[],
    options: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchHit[]> {
    assertUserId(userId);
    assertSearch(queryVector, options);

    if (options.connectionIds?.length === 0) {
      return [];
    }

    const tenant = tenantNameOf(userId);

    return this.call(async (client) => {
      const collection = client.collections.get(this.collection);

      if ((await collection.tenants.getByName(tenant)) === null) {
        return [];
      }

      const store = new WeaviateStore(NO_EMBEDDINGS, {
        client,
        indexName: this.collection,
        tenant,
        textKey: TEXT_KEY,
        metadataKeys: METADATA_KEYS,
      });
      const filter =
        options.connectionIds === undefined
          ? undefined
          : collection.filter
              .byProperty("connectionId")
              .containsAny(options.connectionIds.map((id) => id.toLowerCase()));

      try {
        const results = await store.similaritySearchVectorWithScore(
          [...queryVector],
          options.limit,
          filter,
        );

        return results.map(([document, distance]) =>
          toHit(document.pageContent, document.metadata, distance),
        );
      } catch (error) {
        if (isTenantNotFound(error)) {
          return [];
        }

        throw error;
      }
    });
  }

  async deleteByConnection(userId: string, connectionId: string): Promise<void> {
    assertUserId(userId);
    assertConnectionId(connectionId);

    const tenant = tenantNameOf(userId);

    await this.call(async (client) => {
      const collection = client.collections.get(this.collection);

      if ((await collection.tenants.getByName(tenant)) === null) {
        return;
      }

      const scoped = collection.withTenant(tenant);
      const filter = collection.filter.byProperty("connectionId").equal(connectionId.toLowerCase());

      for (let round = 0; round < MAX_DELETE_ROUNDS; round += 1) {
        const result = await scoped.data.deleteMany(filter);

        if (result.failed > 0) {
          throw new KnowledgeIndexUnavailableError("SERVER_ERROR", true);
        }

        if (result.matches === 0) {
          return;
        }
      }
    });
  }

  async deleteAllForUser(userId: string): Promise<void> {
    assertUserId(userId);

    const tenant = tenantNameOf(userId);

    await this.call(async (client) => {
      // Removing a tenant that does not exist is a no-op on the server.
      await client.collections.get(this.collection).tenants.remove([tenant]);
    });
  }

  /** Closes the connection; the next call connects again. */
  async close(): Promise<void> {
    const pending = this.clientPromise;

    this.clientPromise = undefined;
    this.collectionReady = undefined;

    if (pending !== undefined) {
      await pending.then((client) => client.close()).catch(() => undefined);
    }
  }

  /** One attempt: connect (once), make sure the collection exists, run `operation`, under the timeout. */
  private call<T>(operation: (client: WeaviateClient) => Promise<T>): Promise<T> {
    return withRetry(
      async () =>
        withTimeout(
          this.ready().then(operation),
          this.timeoutMs,
          () => new KnowledgeIndexUnavailableError("TIMEOUT", true),
        ),
      toKnowledgeIndexError,
      this.retry,
      this.wait,
    );
  }

  private async ready(): Promise<WeaviateClient> {
    this.clientPromise ??= this.connect();

    let client: WeaviateClient;

    try {
      client = await this.clientPromise;
    } catch (error) {
      this.clientPromise = undefined;

      throw error;
    }

    this.collectionReady ??= this.ensureCollection(client);

    try {
      await this.collectionReady;
    } catch (error) {
      this.collectionReady = undefined;

      throw error;
    }

    return client;
  }

  private async ensureCollection(client: WeaviateClient): Promise<void> {
    if (await client.collections.exists(this.collection)) {
      return;
    }

    try {
      await client.collections.create({
        name: this.collection,
        // The model and dimension the vectors were made with: changing them means reindexing.
        description: `Knowledge chunks. Embeddings: ${EMBEDDING_MODEL}, ${EMBEDDING_DIMENSIONS} dimensions, computed by the application.`,
        multiTenancy: configure.multiTenancy({ enabled: true, autoTenantCreation: false }),
        vectorizers: configure.vectors.selfProvided({
          vectorIndexConfig: configure.vectorIndex.hnsw({ distanceMetric: "cosine" }),
        }),
        properties: [
          { name: "connectionId", dataType: "text", tokenization: "field", indexSearchable: false },
          { name: "sourceName", dataType: "text", indexFilterable: false, indexSearchable: false },
          { name: "position", dataType: "int" },
          { name: "page", dataType: "int" },
          { name: TEXT_KEY, dataType: "text", indexFilterable: false, indexSearchable: false },
        ],
      });
    } catch (error) {
      // Two processes can race to create it; the loser finds it already there.
      if (!(await client.collections.exists(this.collection))) {
        throw error;
      }
    }
  }
}

function toObject(chunk: KnowledgeChunk): DataObject<undefined> {
  const connectionId = chunk.connectionId.toLowerCase();

  return {
    id: generateUuid5(`${connectionId}:${chunk.position}`, CHUNK_ID_NAMESPACE),
    vectors: [...chunk.vector],
    properties: {
      connectionId,
      sourceName: chunk.sourceName,
      position: chunk.position,
      ...(chunk.page === undefined ? {} : { page: chunk.page }),
      [TEXT_KEY]: chunk.text,
    },
  };
}

function toHit(
  text: string,
  metadata: Record<string, unknown>,
  distance: number,
): KnowledgeSearchHit {
  const { connectionId, sourceName, position, page } = metadata;

  return {
    connectionId: String(connectionId),
    sourceName: String(sourceName),
    position: Number(position),
    ...(typeof page === "number" ? { page } : {}),
    text,
    // Cosine distance is 1 - similarity.
    score: 1 - distance,
  };
}
