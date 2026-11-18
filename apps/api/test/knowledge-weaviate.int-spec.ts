import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import weaviate, { ApiKey, type WeaviateClient } from "weaviate-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMBEDDINGS_GENERATOR,
  KNOWLEDGE_INDEX,
  KnowledgeIndexUnavailableError,
  KnowledgeModule,
  type EmbeddingsGenerator,
  type KnowledgeIndex,
} from "../src/modules/knowledge";
import { tenantNameOf } from "../src/modules/knowledge/domain/knowledge-rules";
import { FakeEmbeddingsGenerator, fakeVectorOf } from "../src/modules/knowledge/testing";
import { InstrumentedKnowledgeIndex } from "../src/modules/knowledge/infrastructure/instrumented";
import {
  createWeaviateConnector,
  WeaviateKnowledgeIndex,
} from "../src/modules/knowledge/infrastructure/weaviate-knowledge-index";
import { baseLogger } from "../src/observability/logger";
import { chunkOf, describeKnowledgeIndexContract } from "./support/knowledge-index-contract";
import { requireWeaviate, TEST_COLLECTION, weaviateTestConfig } from "./support/weaviate";

const config = weaviateTestConfig();
const noWait = () => Promise.resolve();

let index: WeaviateKnowledgeIndex;
let admin: WeaviateClient;

async function connectAdmin(): Promise<WeaviateClient> {
  const { weaviateUrl: url } = config;

  return weaviate.connectToCustom({
    httpHost: url.hostname,
    httpPort: Number(url.port) || 80,
    httpSecure: false,
    grpcHost: url.hostname,
    grpcPort: config.weaviateGrpcPort,
    grpcSecure: false,
    authCredentials: new ApiKey(config.weaviateApiKey),
  });
}

const tenantExists = async (userId: string): Promise<boolean> =>
  (await admin.collections.get(TEST_COLLECTION).tenants.getByName(tenantNameOf(userId))) !== null;

beforeAll(async () => {
  await requireWeaviate();

  admin = await connectAdmin();
  index = new WeaviateKnowledgeIndex(createWeaviateConnector(config), {
    collection: TEST_COLLECTION,
    wait: noWait,
  });
});

afterAll(async () => {
  await index?.close();
  admin?.close();
});

// The same behavior the in-memory fake has: isolation, deletes, idempotency, empty results.
describeKnowledgeIndexContract("WeaviateKnowledgeIndex", () => index);

describe("WeaviateKnowledgeIndex against the local Weaviate", () => {
  it("creates the tenant on the first upsert and never on a read or a delete (R4)", async () => {
    const userId = randomUUID();

    expect(await index.search(userId, fakeVectorOf("nothing"), { limit: 3 })).toEqual([]);
    await index.deleteByConnection(userId, randomUUID());
    expect(await tenantExists(userId)).toBe(false);

    await index.upsert(userId, [chunkOf(randomUUID(), 0, "creates the tenant")]);
    expect(await tenantExists(userId)).toBe(true);

    await index.deleteAllForUser(userId);
    expect(await tenantExists(userId)).toBe(false);
    expect(await index.search(userId, fakeVectorOf("creates the tenant"), { limit: 3 })).toEqual(
      [],
    );
    expect(await tenantExists(userId)).toBe(false);
  });

  it("keeps the product collection multi-tenant, without a vectorizer, cosine and with model and dimension on record", async () => {
    await index.upsert(randomUUID(), [chunkOf(randomUUID(), 0, "forces the collection to exist")]);

    const collection = await admin.collections.get(TEST_COLLECTION).config.get();

    expect(collection.multiTenancy.enabled).toBe(true);
    expect(collection.description).toContain("text-embedding-3-small");
    expect(collection.description).toContain("1536");
    expect(collection.vectorizers.default?.vectorizer.name).toBe("none");
    expect(collection.vectorizers.default?.indexConfig).toMatchObject({ distance: "cosine" });
  });

  it("writes more chunks than one batch and deletes them all (R5)", async () => {
    const userId = randomUUID();
    const connectionId = randomUUID();
    const chunks = Array.from({ length: 250 }, (_, position) =>
      chunkOf(connectionId, position, `bulk chunk number ${position}`),
    );

    try {
      await index.upsert(userId, chunks);

      const hits = await index.search(userId, fakeVectorOf("bulk chunk number 7"), { limit: 100 });

      expect(hits).toHaveLength(100);
      expect(hits[0]?.position).toBe(7);

      await index.deleteByConnection(userId, connectionId);

      expect(
        await index.search(userId, fakeVectorOf("bulk chunk number 7"), { limit: 100 }),
      ).toEqual([]);
    } finally {
      await index.deleteAllForUser(userId);
    }
  });

  it("matches connection ids regardless of letter case", async () => {
    const userId = randomUUID();
    const connectionId = randomUUID();

    try {
      await index.upsert(userId, [chunkOf(connectionId.toUpperCase(), 0, "case insensitive")]);

      const hits = await index.search(userId, fakeVectorOf("case insensitive"), {
        limit: 5,
        connectionIds: [connectionId],
      });

      expect(hits.map((hit) => hit.connectionId)).toEqual([connectionId]);

      await index.deleteByConnection(userId, connectionId.toUpperCase());

      expect(await index.search(userId, fakeVectorOf("case insensitive"), { limit: 5 })).toEqual(
        [],
      );
    } finally {
      await index.deleteAllForUser(userId);
    }
  });

  it("answers within the timeout with a typed error when Weaviate is not there, without network details (R7)", async () => {
    const down = new WeaviateKnowledgeIndex(
      createWeaviateConnector({
        weaviateUrl: new URL("http://127.0.0.1:1"),
        weaviateGrpcPort: 2,
        weaviateApiKey: config.weaviateApiKey,
      }),
      { collection: TEST_COLLECTION, timeoutMs: 3_000, wait: noWait },
    );
    const startedAt = performance.now();

    const error = await down
      .search(randomUUID(), fakeVectorOf("SENTINEL-offline-text"), { limit: 3 })
      .catch((caught: unknown) => caught);

    expect(performance.now() - startedAt).toBeLessThan(10_000);
    expect(error).toBeInstanceOf(KnowledgeIndexUnavailableError);
    expect(error).toMatchObject({ code: "CONNECTION", retryable: true, attempts: 3 });

    const failure = error as Error;

    expect(failure.message).toBe("Knowledge index unavailable: CONNECTION");
    expect(failure.stack ?? "").not.toMatch(/ECONNREFUSED|fetch failed|127\.0\.0\.1/);
    expect(failure.cause).toBeUndefined();

    await down.close();
  });

  it("reports a wrong API key as UNAUTHORIZED without retrying (R7)", async () => {
    const wrongKey = new WeaviateKnowledgeIndex(
      createWeaviateConnector({ ...config, weaviateApiKey: "not-the-key" }),
      { collection: TEST_COLLECTION, wait: noWait },
    );

    await expect(
      wrongKey.search(randomUUID(), fakeVectorOf("x"), { limit: 3 }),
    ).rejects.toMatchObject({
      name: "KnowledgeIndexUnavailableError",
      code: "UNAUTHORIZED",
      retryable: false,
      attempts: 1,
    });

    await wrongKey.close();
  });

  it("never writes chunk text, vectors or tenant names to a log, the console or an error (R7, R8)", async () => {
    const sentinel = "SENTINEL-chunk-text-93ac";
    const userId = randomUUID();
    const connectionId = randomUUID();
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
      vi.spyOn(baseLogger, "info"),
      vi.spyOn(baseLogger, "warn"),
      vi.spyOn(baseLogger, "error"),
    ];

    try {
      const observed = new InstrumentedKnowledgeIndex(index);

      await observed.upsert(userId, [chunkOf(connectionId, 0, sentinel)]);
      await observed.search(userId, fakeVectorOf(sentinel), { limit: 3 });
      await observed.deleteByConnection(userId, connectionId);
      await observed.deleteAllForUser(userId);

      const emitted = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));

      for (const secret of [
        sentinel,
        userId,
        connectionId,
        tenantNameOf(userId),
        String(fakeVectorOf(sentinel)[0]),
      ]) {
        expect(emitted).not.toContain(secret);
      }
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      await index.deleteAllForUser(userId);
    }
  });

  it.runIf(process.env.KNOWLEDGE_PERF === "1")(
    "searches 10 thousand chunks in under 300 ms (spec metric; opt in with KNOWLEDGE_PERF=1)",
    async () => {
      const userId = randomUUID();
      const connectionId = randomUUID();

      try {
        for (let start = 0; start < 10_000; start += 500) {
          await index.upsert(
            userId,
            Array.from({ length: 500 }, (_, offset) =>
              chunkOf(connectionId, start + offset, `performance chunk ${start + offset}`),
            ),
          );
        }

        await index.search(userId, fakeVectorOf("performance chunk 1"), { limit: 5 });

        const timings: number[] = [];

        for (let run = 0; run < 10; run += 1) {
          const startedAt = performance.now();

          await index.search(userId, fakeVectorOf(`performance chunk ${run * 97}`), { limit: 5 });
          timings.push(performance.now() - startedAt);
        }

        console.info(
          `knowledge perf: search over 10000 chunks, ms per call: ${timings.map((ms) => ms.toFixed(1)).join(" ")}`,
        );

        expect(Math.max(...timings)).toBeLessThan(300);
      } finally {
        await index.deleteAllForUser(userId);
      }
    },
    300_000,
  );
});

describe("KnowledgeModule", () => {
  const ENV = {
    WEAVIATE_URL: config.weaviateUrl.toString(),
    WEAVIATE_API_KEY: config.weaviateApiKey,
    WEAVIATE_COLLECTION: TEST_COLLECTION,
  };

  async function compile() {
    return Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), KnowledgeModule],
    }).compile();
  }

  it("wires the index and, with NODE_ENV=test, the offline embeddings generator", async () => {
    const saved = { ...process.env };

    Object.assign(process.env, ENV, { NODE_ENV: "test" });
    delete process.env.OPENAI_API_KEY;

    const moduleRef = await compile();

    try {
      const wired = moduleRef.get<KnowledgeIndex>(KNOWLEDGE_INDEX);
      const generator = moduleRef.get<EmbeddingsGenerator>(EMBEDDINGS_GENERATOR);
      const userId = randomUUID();
      const connectionId = randomUUID();

      expect(generator).toBeInstanceOf(FakeEmbeddingsGenerator);

      const [vector] = await generator.embedDocuments(["wired end to end"]);

      await wired.upsert(userId, [
        {
          connectionId,
          sourceName: "wired.txt",
          position: 0,
          text: "wired end to end",
          vector: vector ?? [],
        },
      ]);

      const hits = await wired.search(userId, await generator.embedQuery("wired end to end"), {
        limit: 1,
      });

      expect(hits[0]?.text).toBe("wired end to end");

      await wired.deleteAllForUser(userId);
    } finally {
      await moduleRef.close();
      process.env = saved;
    }
  });

  it("uses OpenAI embeddings outside the test environment and fails typed, offline, without a key", async () => {
    const saved = { ...process.env };

    Object.assign(process.env, ENV, { NODE_ENV: "dev" });
    delete process.env.OPENAI_API_KEY;

    const moduleRef = await compile();

    try {
      const generator = moduleRef.get<EmbeddingsGenerator>(EMBEDDINGS_GENERATOR);

      expect(generator).not.toBeInstanceOf(FakeEmbeddingsGenerator);
      await expect(generator.embedDocuments(["x"])).rejects.toMatchObject({
        name: "EmbeddingsUnavailableError",
        code: "NOT_CONFIGURED",
      });
    } finally {
      await moduleRef.close();
      process.env = saved;
    }
  });

  it("refuses to load without WEAVIATE_API_KEY, naming the variable", async () => {
    const saved = { ...process.env };

    Object.assign(process.env, ENV, { NODE_ENV: "test" });
    delete process.env.WEAVIATE_API_KEY;

    try {
      await expect(compile()).rejects.toThrow(/WEAVIATE_API_KEY/);
    } finally {
      process.env = saved;
    }
  });
});
