import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/bootstrap";
import { SessionService } from "../src/modules/auth/application/services/session.service";
import { ConnectionProcessor } from "../src/modules/connections/application/services/connection-processor";
import type { ConversationRepository } from "../src/modules/experts/domain/conversation-ports";
import { CONVERSATION_REPOSITORY } from "../src/modules/experts/experts.tokens";
import {
  EMBEDDINGS_GENERATOR,
  type EmbeddingsGenerator,
  KNOWLEDGE_INDEX,
  KnowledgeIndexUnavailableError,
  type KnowledgeChunk,
  type KnowledgeIndex,
  type KnowledgeSearchHit,
  type KnowledgeSearchOptions,
} from "../src/modules/knowledge";
import {
  createWeaviateConnector,
  WeaviateKnowledgeIndex,
} from "../src/modules/knowledge/infrastructure/weaviate-knowledge-index";
import { FakeEmbeddingsGenerator, fakeVectorOf } from "../src/modules/knowledge/testing";
import { baseLogger } from "../src/observability/logger";
import {
  assertMigrationsApplied,
  deleteUsersByEmail,
  query,
  rows,
  sha256,
} from "./support/database";
import { resetRateLimitStore } from "./support/rate-limit";
import { seedConfirmedUser } from "./support/sessions";
import { startTelemetryRecorder, type TelemetryRecorder } from "./support/telemetry";
import { requireWeaviate, TEST_COLLECTION, weaviateTestConfig } from "./support/weaviate";

const CONNECTIONS_PATH = "/api/v1/connections";
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const noWait = () => Promise.resolve();
const MINUTE = 60_000;

/** Counts the embedding calls so a test can prove that a re-upload after a deletion reprocesses. */
class CountingEmbeddings implements EmbeddingsGenerator {
  documentCalls = 0;
  private readonly inner = new FakeEmbeddingsGenerator();

  embedDocuments(texts: readonly string[]): Promise<number[][]> {
    this.documentCalls += 1;

    return this.inner.embedDocuments(texts);
  }

  embedQuery(text: string): Promise<number[]> {
    return this.inner.embedQuery(text);
  }
}

/** The real Weaviate index, with a switch that makes the deletions fail like an outage would. */
class SwitchableIndex implements KnowledgeIndex {
  failDeletes = false;

  constructor(private readonly inner: KnowledgeIndex) {}

  upsert(userId: string, chunks: readonly KnowledgeChunk[]): Promise<void> {
    return this.inner.upsert(userId, chunks);
  }

  search(
    userId: string,
    queryVector: readonly number[],
    options: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchHit[]> {
    return this.inner.search(userId, queryVector, options);
  }

  deleteByConnection(userId: string, connectionId: string): Promise<void> {
    return this.failDeletes
      ? Promise.reject(new KnowledgeIndexUnavailableError("CONNECTION", true, 3))
      : this.inner.deleteByConnection(userId, connectionId);
  }

  deleteAllForUser(userId: string): Promise<void> {
    return this.failDeletes
      ? Promise.reject(new KnowledgeIndexUnavailableError("CONNECTION", true, 3))
      : this.inner.deleteAllForUser(userId);
  }
}

interface ConnectionBody {
  id: string;
  name: string;
  kind: string;
  sizeBytes: number;
  status: "processing" | "ready" | "failed";
  chunkCount: number;
  errorCode: string | null;
  createdAt: string;
  deduplicated?: boolean;
}

interface SeedOptions {
  name?: string;
  status?: "ready" | "processing" | "failed";
  /** Minutes since the last update (a `processing` older than 15 is stale). */
  ageMinutes?: number;
  chunks?: number;
  createdAt?: string;
}

describe("manage connections API (Postgres and Weaviate local, fake embeddings)", () => {
  const createdEmails: string[] = [];
  const createdUserIds: string[] = [];
  const embeddings = new CountingEmbeddings();
  let index: SwitchableIndex;
  let real: WeaviateKnowledgeIndex;
  let app: INestApplication;
  let processor: ConnectionProcessor;
  let recorder: TelemetryRecorder;
  let owner: { id: string; token: string };
  let other: { id: string; token: string };

  async function newUser(label: string) {
    const user = await seedConfirmedUser(label);

    createdEmails.push(user.email);
    createdUserIds.push(user.id);

    return { id: user.id, token: (await app.get(SessionService).issue(user.id)).accessToken };
  }

  /** A connection row of the user, with its chunks in the real index. */
  async function seed(userId: string, options: SeedOptions = {}): Promise<string> {
    const { name = "plano.pdf", status = "ready", ageMinutes = 0, chunks = 1, createdAt } = options;
    const [created] = await rows<{ id: string }>(
      `insert into public.connections
         (user_id, kind, name, size_bytes, content_hash, status, chunk_count, error_code, created_at, updated_at)
       values ($1, 'txt', $2, 10, $3, $4, $5, $6, coalesce($7::timestamptz, now()),
               now() - ($8 || ' minutes')::interval)
       returning id`,
      [
        userId,
        name,
        sha256(randomUUID()),
        status,
        status === "ready" ? chunks : 0,
        status === "failed" ? "NO_EXTRACTABLE_TEXT" : null,
        createdAt ?? null,
        String(ageMinutes),
      ],
    );
    const connectionId = created?.id ?? "";

    if (status === "ready") {
      await real.upsert(
        userId,
        Array.from({ length: chunks }, (_, position) => ({
          connectionId,
          sourceName: name,
          position,
          text: `${connectionId} chunk ${position}`,
          vector: fakeVectorOf(`${connectionId} chunk ${position}`),
        })),
      );
    }

    return connectionId;
  }

  const chunksOf = (connectionId: string, userId: string) =>
    real.search(userId, fakeVectorOf("anything"), { limit: 100, connectionIds: [connectionId] });

  const tenantChunks = (userId: string) =>
    real.search(userId, fakeVectorOf("anything"), { limit: 100 });

  const rowCount = async (userId: string) =>
    (
      await rows<{ total: number }>(
        "select count(*)::int as total from public.connections where user_id = $1",
        [userId],
      )
    )[0]?.total;

  const list = (token: string | null = owner.token) => {
    const call = request(app.getHttpServer()).get(CONNECTIONS_PATH);

    return token === null ? call : call.set(bearer(token));
  };

  const remove = (id: string, token: string | null = owner.token) => {
    const call = request(app.getHttpServer()).delete(`${CONNECTIONS_PATH}/${id}`);

    return token === null ? call : call.set(bearer(token));
  };

  const removeAll = (token: string | null = owner.token) => {
    const call = request(app.getHttpServer()).delete(CONNECTIONS_PATH);

    return token === null ? call : call.set(bearer(token));
  };

  const upload = (name: string, content: string, token = owner.token) =>
    request(app.getHttpServer())
      .post(CONNECTIONS_PATH)
      .set(bearer(token))
      .attach("file", Buffer.from(content, "utf8"), { filename: name, contentType: "text/plain" });

  async function reset() {
    for (const { id } of [owner, other]) {
      await query("delete from public.expert_conversations where user_id = $1", [id]);
      await query("delete from public.connections where user_id = $1", [id]);
      await real.deleteAllForUser(id).catch(() => undefined);
    }
  }

  beforeAll(async () => {
    await assertMigrationsApplied();
    await requireWeaviate();

    recorder = startTelemetryRecorder();

    real = new WeaviateKnowledgeIndex(createWeaviateConnector(weaviateTestConfig()), {
      collection: TEST_COLLECTION,
      wait: noWait,
    });
    index = new SwitchableIndex(real);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDINGS_GENERATOR)
      .useValue(embeddings)
      .overrideProvider(KNOWLEDGE_INDEX)
      .useValue(index)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    processor = app.get(ConnectionProcessor, { strict: false });

    owner = await newUser("manage-owner");
    other = await newUser("manage-other");
  });

  afterAll(async () => {
    await processor?.idle();
    await Promise.all(createdUserIds.map((id) => real.deleteAllForUser(id).catch(() => undefined)));
    await app?.close();
    await real?.close();
    await deleteUsersByEmail(createdEmails);
    await recorder?.stop();
  });

  beforeEach(async () => {
    resetRateLimitStore(app);
    index.failDeletes = false;
    embeddings.documentCalls = 0;
    await reset();
  });

  describe("authentication", () => {
    it("answers 401 to the list and to both deletions without a session", async () => {
      expect((await list(null)).status).toBe(401);
      expect((await remove(randomUUID(), null)).status).toBe(401);
      expect((await removeAll(null)).status).toBe(401);
    });
  });

  describe("GET /connections (R1)", () => {
    it("lists only the connections of the session user, the most recent first", async () => {
      const oldest = await seed(owner.id, { name: "a.txt", createdAt: "2026-11-01T10:00:00Z" });
      const newest = await seed(owner.id, { name: "c.txt", createdAt: "2026-11-03T10:00:00Z" });
      const middle = await seed(owner.id, {
        name: "b.txt",
        status: "failed",
        createdAt: "2026-11-02T10:00:00Z",
      });

      await seed(other.id, { name: "theirs-1.txt" });
      await seed(other.id, { name: "theirs-2.txt" });

      const response = await list();
      const body = response.body as { connections: ConnectionBody[] };

      expect(response.status).toBe(200);
      expect(body.connections.map((connection) => connection.id)).toEqual([newest, middle, oldest]);
      expect(body.connections[1]).toMatchObject({
        name: "b.txt",
        kind: "txt",
        sizeBytes: 10,
        status: "failed",
        chunkCount: 0,
        errorCode: "NO_EXTRACTABLE_TEXT",
      });
      expect(Object.keys(body.connections[0] ?? {}).sort()).toEqual([
        "chunkCount",
        "createdAt",
        "errorCode",
        "id",
        "kind",
        "name",
        "sizeBytes",
        "status",
      ]);
    });

    it("answers 200 with an empty list when there is nothing", async () => {
      const response = await list();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ connections: [] });
    });
  });

  describe("DELETE /connections/:id (R2, R3, R4, R5)", () => {
    it("removes the vectors and the row, and a repeat answers 404", async () => {
      const id = await seed(owner.id, { chunks: 3 });
      const keptId = await seed(owner.id, { name: "kept.txt", chunks: 2 });

      expect(await chunksOf(id, owner.id)).toHaveLength(3);

      const response = await remove(id);

      expect(response.status).toBe(204);
      expect(response.text).toBe("");
      expect(await chunksOf(id, owner.id)).toEqual([]);
      expect(await rowCount(owner.id)).toBe(1);
      expect(await chunksOf(keptId, owner.id)).toHaveLength(2);

      const again = await remove(id);

      expect(again.status).toBe(404);
      expect(again.body.error.code).toBe("CONNECTION_NOT_FOUND");
    });

    it("answers 404 for another user's connection and changes nothing, and 400 for a bad id", async () => {
      const theirs = await seed(other.id, { chunks: 2 });

      const response = await remove(theirs);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("CONNECTION_NOT_FOUND");
      expect(await rowCount(other.id)).toBe(1);
      expect(await chunksOf(theirs, other.id)).toHaveLength(2);

      const invalid = await remove("not-a-uuid");

      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe("VALIDATION_FAILED");
      expect((await remove(randomUUID())).status).toBe(404);
    });

    it("answers 503 and keeps the row and the vectors while the index is down, and 204 once it is back", async () => {
      const id = await seed(owner.id, { chunks: 2 });

      index.failDeletes = true;

      const failed = await remove(id);

      expect(failed.status).toBe(503);
      expect(failed.body.error.code).toBe("KNOWLEDGE_UNAVAILABLE");
      expect(await rowCount(owner.id)).toBe(1);
      expect(await chunksOf(id, owner.id)).toHaveLength(2);
      expect(((await list()).body as { connections: unknown[] }).connections).toHaveLength(1);

      index.failDeletes = false;

      expect((await remove(id)).status).toBe(204);
      expect(await rowCount(owner.id)).toBe(0);
      expect(await chunksOf(id, owner.id)).toEqual([]);
    });

    it("answers 409 while it is processing, and deletes a failed one and one stuck for over 15 minutes", async () => {
      const processing = await seed(owner.id, { status: "processing", name: "busy.txt" });
      const failed = await seed(owner.id, { status: "failed", name: "failed.txt" });
      const stuck = await seed(owner.id, {
        status: "processing",
        name: "stuck.txt",
        ageMinutes: 16,
      });

      const refused = await remove(processing);

      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("CONNECTION_PROCESSING");
      expect(await rowCount(owner.id)).toBe(3);

      expect((await remove(failed)).status).toBe(204);
      expect((await remove(stuck)).status).toBe(204);
      expect(await rowCount(owner.id)).toBe(1);
    });

    it("forgets the deduplication identity: the same file is processed again from scratch (R5)", async () => {
      const content = "A short note about the training plan of the squad.";
      const first = await upload("note.txt", content);

      expect(first.status).toBe(202);
      await processor.idle();

      const firstId = (first.body as ConnectionBody).id;

      expect(embeddings.documentCalls).toBe(1);
      expect(await chunksOf(firstId, owner.id)).not.toHaveLength(0);

      // While it exists, the same bytes are deduplicated.
      const duplicate = await upload("note-copy.txt", content);

      expect(duplicate.body).toMatchObject({ id: firstId, deduplicated: true });
      expect(embeddings.documentCalls).toBe(1);

      expect((await remove(firstId)).status).toBe(204);
      expect(await chunksOf(firstId, owner.id)).toEqual([]);

      const again = await upload("note.txt", content);
      const againBody = again.body as ConnectionBody;

      await processor.idle();

      expect(again.status).toBe(202);
      expect(againBody.deduplicated).toBe(false);
      expect(againBody.id).not.toBe(firstId);
      expect(embeddings.documentCalls).toBe(2);
      expect(await chunksOf(againBody.id, owner.id)).not.toHaveLength(0);
    });
  });

  describe("DELETE /connections (R6)", () => {
    it("removes the tenant and every row of the user, repeating is 204, and the other user keeps their data", async () => {
      for (let number = 0; number < 5; number += 1) {
        await seed(owner.id, { name: `mine-${number}.txt`, chunks: 2 });
      }

      const theirs = await seed(other.id, { name: "theirs.txt", chunks: 2 });

      expect(await tenantChunks(owner.id)).toHaveLength(10);

      const response = await removeAll();

      expect(response.status).toBe(204);
      expect(((await list()).body as { connections: unknown[] }).connections).toEqual([]);
      expect(await rowCount(owner.id)).toBe(0);
      expect(await tenantChunks(owner.id)).toEqual([]);
      expect((await removeAll()).status).toBe(204);

      expect(await rowCount(other.id)).toBe(1);
      expect(await chunksOf(theirs, other.id)).toHaveLength(2);
    });

    it("is a 204 for a user who never had a connection", async () => {
      expect((await removeAll(other.token)).status).toBe(204);
    });

    it("answers 409 and deletes nothing while one connection is processing", async () => {
      const ready = await seed(owner.id, { chunks: 2 });

      await seed(owner.id, { status: "processing", name: "busy.txt" });

      const response = await removeAll();

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("CONNECTION_PROCESSING");
      expect(await rowCount(owner.id)).toBe(2);
      expect(await chunksOf(ready, owner.id)).toHaveLength(2);
    });

    it("answers 503 and keeps every row while the index is down, and finishes when it is back", async () => {
      await seed(owner.id, { chunks: 2 });
      await seed(owner.id, { name: "second.txt", chunks: 1 });
      index.failDeletes = true;

      const failed = await removeAll();

      expect(failed.status).toBe(503);
      expect(failed.body.error.code).toBe("KNOWLEDGE_UNAVAILABLE");
      expect(await rowCount(owner.id)).toBe(2);
      expect(await tenantChunks(owner.id)).toHaveLength(3);

      index.failDeletes = false;

      expect((await removeAll()).status).toBe(204);
      expect(await rowCount(owner.id)).toBe(0);
      expect(await tenantChunks(owner.id)).toEqual([]);
    });
  });

  describe("citations of deleted sources (R7)", () => {
    it("shows 'removed' without the name once the connection is deleted, and keeps the answer", async () => {
      const kept = await seed(owner.id, { name: "kept.txt" });
      const gone = await seed(owner.id, { name: "SENTINEL-secret-source.txt" });
      const conversations = app.get<ConversationRepository>(CONVERSATION_REPOSITORY, {
        strict: false,
      });

      await conversations.append(owner.id, "head-coach", {
        role: "user",
        content: "What does the plan say?",
        status: "complete",
      });
      await conversations.append(owner.id, "head-coach", {
        role: "assistant",
        content: "It says to rest on Sundays.",
        status: "complete",
        citations: [
          { connectionId: kept, sourceName: "kept.txt", page: 1, position: 0 },
          { connectionId: gone, sourceName: "SENTINEL-secret-source.txt", page: null, position: 0 },
        ],
      });

      const read = () =>
        request(app.getHttpServer())
          .get("/api/v1/experts/head-coach/conversation")
          .set(bearer(owner.token));
      const before = await read();

      expect(before.body.messages[1].citations).toEqual([
        { connectionId: kept, sourceName: "kept.txt", page: 1, position: 0, removed: false },
        {
          connectionId: gone,
          sourceName: "SENTINEL-secret-source.txt",
          page: null,
          position: 0,
          removed: false,
        },
      ]);

      expect((await remove(gone)).status).toBe(204);

      const after = await read();

      expect(after.body.messages[1]).toMatchObject({
        content: "It says to rest on Sundays.",
        citations: [
          { connectionId: kept, sourceName: "kept.txt", page: 1, position: 0, removed: false },
          { connectionId: gone, removed: true },
        ],
      });
      expect(JSON.stringify(after.body)).not.toContain("SENTINEL-secret-source");

      // The other user cannot make a source of this user look alive: ids are checked per user.
      await seed(other.id, { name: "other.txt" });
      expect((await removeAll()).status).toBe(204);
      expect(
        (await read()).body.messages[1].citations.every(
          (citation: { removed: boolean }) => citation.removed,
        ),
      ).toBe(true);
    });
  });

  describe("privacy (R9)", () => {
    it("never puts the file name, an id or the user in a log, a span or a metric, and counts the deletions", async () => {
      const sentinel = "SENTINEL-name-9c3d";
      const id = await seed(owner.id, { name: `${sentinel}.txt` });

      await seed(owner.id, { name: `${sentinel}-2.txt`, status: "processing" });

      const spies = [
        vi.spyOn(console, "log"),
        vi.spyOn(console, "error"),
        vi.spyOn(console, "warn"),
        vi.spyOn(baseLogger, "info"),
        vi.spyOn(baseLogger, "warn"),
        vi.spyOn(baseLogger, "error"),
      ];

      // Flushes what earlier tests counted, so `reset()` leaves only this test's deletions.
      await recorder.metric("connection.deletions");
      recorder.reset();

      try {
        await list();
        await remove(id);
        await remove(id);
        await removeAll();
        index.failDeletes = true;
        await remove(randomUUID());

        const emitted = JSON.stringify({
          logs: spies.flatMap((spy) => spy.mock.calls).filter((call) => !isAccessLog(call[0])),
          spans: recorder.exportedSpans(),
          deletions: await recorder.metric("connection.deletions"),
        });

        for (const secret of [sentinel, id, owner.id]) {
          expect(emitted).not.toContain(secret);
        }

        const events = spies
          .flatMap((spy) => spy.mock.calls)
          .map((call) => call[0])
          .filter(
            (fields): fields is { event: string; scope: string; outcome: string } =>
              typeof fields === "object" &&
              fields !== null &&
              (fields as { event?: unknown }).event === "connection_deleted",
          )
          .map(({ scope, outcome }) => [scope, outcome]);

        expect(events).toEqual([
          ["single", "success"],
          ["single", "not_found"],
          ["all", "processing"],
          ["single", "not_found"],
        ]);

        const points = (await recorder.metric("connection.deletions")).map((point) => ({
          ...point.attributes,
          value: point.value,
        }));

        expect(points).toEqual(
          expect.arrayContaining([
            { scope: "single", outcome: "success", value: 1 },
            { scope: "single", outcome: "not_found", value: 2 },
            { scope: "all", outcome: "processing", value: 1 },
          ]),
        );
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });
  });

  it("times a single deletion well below 3 seconds (success metric)", async () => {
    const id = await seed(owner.id, { chunks: 20 });
    const startedAt = performance.now();

    expect((await remove(id)).status).toBe(204);
    expect(performance.now() - startedAt).toBeLessThan(3000);
  });

  it("treats a processing row that went stale as deletable by the clock the spec defines (15 minutes)", async () => {
    const stuck = await seed(owner.id, { status: "processing", ageMinutes: 14 });

    expect((await remove(stuck)).status).toBe(409);

    await query(
      "update public.connections set updated_at = now() - ($2 || ' milliseconds')::interval where id = $1",
      [stuck, String(15 * MINUTE + 1000)],
    );

    expect((await remove(stuck)).status).toBe(204);
  });
});

/** The `pino-http` access log is left out: its serializers run after the call (see connections.int-spec). */
function isAccessLog(first: unknown): boolean {
  return typeof first === "object" && first !== null && ("req" in first || "res" in first);
}
