import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/bootstrap";
import { SessionService } from "../src/modules/auth/application/services/session.service";
import { ConnectionProcessor } from "../src/modules/connections/application/services/connection-processor";
import {
  buildPdf,
  buildProtectedPdf,
  sentences,
  wrapLines,
} from "../src/modules/connections/testing";
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
import { FakeEmbeddingsGenerator, fakeVectorOf } from "../src/modules/knowledge/testing";
import {
  createWeaviateConnector,
  WeaviateKnowledgeIndex,
} from "../src/modules/knowledge/infrastructure/weaviate-knowledge-index";
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
const MB = 1024 * 1024;

/** Counts the embedding calls so a test can prove that a duplicate costs none. */
class CountingEmbeddings implements EmbeddingsGenerator {
  documentCalls = 0;
  texts = 0;
  private readonly inner = new FakeEmbeddingsGenerator();

  embedDocuments(texts: readonly string[]): Promise<number[][]> {
    this.documentCalls += 1;
    this.texts += texts.length;

    return this.inner.embedDocuments(texts);
  }

  embedQuery(text: string): Promise<number[]> {
    return this.inner.embedQuery(text);
  }
}

/** The real Weaviate index, with counters and a switch that makes `upsert` fail after it wrote. */
class SpyIndex implements KnowledgeIndex {
  upserts = 0;
  failAfterWrite = false;

  constructor(private readonly inner: KnowledgeIndex) {}

  async upsert(userId: string, chunks: readonly KnowledgeChunk[]): Promise<void> {
    this.upserts += 1;
    await this.inner.upsert(userId, chunks);

    if (this.failAfterWrite) {
      throw new KnowledgeIndexUnavailableError("CONNECTION", true);
    }
  }

  search(
    userId: string,
    queryVector: readonly number[],
    options: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchHit[]> {
    return this.inner.search(userId, queryVector, options);
  }

  deleteByConnection(userId: string, connectionId: string): Promise<void> {
    return this.inner.deleteByConnection(userId, connectionId);
  }

  deleteAllForUser(userId: string): Promise<void> {
    return this.inner.deleteAllForUser(userId);
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

const leftoverWorkDirectories = () =>
  readdirSync(tmpdir()).filter((name) => name.startsWith("rondo-connection-"));

describe("connections API (Postgres and Weaviate local, fake embeddings)", () => {
  const createdEmails: string[] = [];
  const createdUserIds: string[] = [];
  const embeddings = new CountingEmbeddings();
  let index: SpyIndex;
  let real: WeaviateKnowledgeIndex;
  let app: INestApplication;
  let processor: ConnectionProcessor;
  let recorder: TelemetryRecorder;
  let token: string;
  let userId: string;

  async function newUser(label: string) {
    const user = await seedConfirmedUser(label);

    createdEmails.push(user.email);
    createdUserIds.push(user.id);

    return {
      id: user.id,
      token: (await app.get(SessionService).issue(user.id)).accessToken,
    };
  }

  const upload = (
    file: { name: string; bytes: Buffer; type?: string },
    withToken: string | null = token,
  ) => {
    const call = request(app.getHttpServer())
      .post(CONNECTIONS_PATH)
      .attach("file", file.bytes, {
        filename: file.name,
        contentType: file.type ?? "application/octet-stream",
      });

    return withToken === null ? call : call.set(bearer(withToken));
  };

  const status = (id: string, withToken: string | null = token) => {
    const call = request(app.getHttpServer()).get(`${CONNECTIONS_PATH}/${id}`);

    return withToken === null ? call : call.set(bearer(withToken));
  };

  /** Waits for the background processing and returns the settled connection. */
  async function settled(id: string, withToken = token): Promise<ConnectionBody> {
    await processor.idle();

    const response = await status(id, withToken);

    return response.body as ConnectionBody;
  }

  const chunksOf = (connectionId: string, forUser = userId, text = "anything") =>
    real.search(forUser, fakeVectorOf(text), { limit: 100, connectionIds: [connectionId] });

  const rowsOf = (forUser = userId) =>
    rows<{ id: string; status: string; chunk_count: number }>(
      "select id, status, chunk_count from public.connections where user_id = $1",
      [forUser],
    );

  beforeAll(async () => {
    await assertMigrationsApplied();
    await requireWeaviate();

    recorder = startTelemetryRecorder();

    const config = weaviateTestConfig();

    real = new WeaviateKnowledgeIndex(createWeaviateConnector(config), {
      collection: TEST_COLLECTION,
      wait: noWait,
    });
    index = new SpyIndex(real);

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

    ({ id: userId, token } = await newUser("connections"));
  });

  afterAll(async () => {
    await processor?.idle();
    await Promise.all(createdUserIds.map((id) => real.deleteAllForUser(id).catch(() => undefined)));
    await app?.close();
    await real?.close();
    await deleteUsersByEmail(createdEmails);
    await recorder?.stop();
  });

  beforeEach(() => {
    resetRateLimitStore(app);
    embeddings.documentCalls = 0;
    embeddings.texts = 0;
    index.upserts = 0;
    index.failAfterWrite = false;
  });

  describe("authentication and limits (R2)", () => {
    it("answers 401 without a session", async () => {
      const response = await upload({ name: "a.txt", bytes: Buffer.from("x") }, null);

      expect(response.status).toBe(401);
      expect((await status("0b5d9f0e-3c52-4a8e-b2a2-8a1d6d9e0f11", null)).status).toBe(401);
    });

    it("answers 429 above 20 uploads in 10 minutes from the same IP", async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        expect((await upload({ name: "empty.txt", bytes: Buffer.alloc(0) })).status).toBe(400);
      }

      const limited = await upload({ name: "empty.txt", bytes: Buffer.alloc(0) });

      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe("RATE_LIMITED");
    });

    it("rejects a program renamed to .pdf by the bytes, whatever the extension and type say", async () => {
      const response = await upload({
        name: "plan.pdf",
        bytes: Buffer.from("MZ\x90\x00 this is an executable"),
        type: "application/pdf",
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("UNSUPPORTED_FILE");
    });

    it("rejects an unsupported extension and content type before reading the file", async () => {
      const byExtension = await upload({ name: "virus.exe", bytes: Buffer.from("MZ") });
      const byType = await upload({
        name: "picture.pdf",
        bytes: Buffer.from("%PDF-1.4"),
        type: "image/png",
      });

      expect(byExtension.body.error.code).toBe("UNSUPPORTED_FILE");
      expect(byType.body.error.code).toBe("UNSUPPORTED_FILE");
      expect(await rowsOf()).toEqual([]);
    });

    it("answers 413 FILE_TOO_LARGE above 20 MB and accepts exactly 20 MB", async () => {
      const tooLarge = await upload({ name: "big.txt", bytes: Buffer.alloc(20 * MB + 1, 0x61) });

      expect(tooLarge.status).toBe(413);
      expect(tooLarge.body.error.code).toBe("FILE_TOO_LARGE");
    });

    it("answers 400 EMPTY_FILE for an empty file and 400 VALIDATION_FAILED without a file", async () => {
      const empty = await upload({ name: "empty.md", bytes: Buffer.alloc(0) });
      const missing = await request(app.getHttpServer())
        .post(CONNECTIONS_PATH)
        .set(bearer(token))
        .send({});

      expect(empty.body.error.code).toBe("EMPTY_FILE");
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe("VALIDATION_FAILED");
    });

    it("refuses the 51st connection with 409 but still deduplicates an existing file", async () => {
      const limited = await newUser("connections-limit");
      const known = Buffer.from("already connected content");

      for (let number = 0; number < 50; number += 1) {
        await query(
          `insert into public.connections (user_id, kind, name, size_bytes, content_hash, status, chunk_count)
           values ($1, 'txt', $2, 10, $3, 'ready', 1)`,
          [
            limited.id,
            `seed-${number}.txt`,
            number === 0 ? sha256Of(known) : sha256(`seed-${number}`),
          ],
        );
      }

      const refused = await upload(
        { name: "new.txt", bytes: Buffer.from("brand new") },
        limited.token,
      );
      const duplicate = await upload({ name: "again.txt", bytes: known }, limited.token);

      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("CONNECTION_LIMIT_REACHED");
      expect(duplicate.status).toBe(200);
      expect(duplicate.body.deduplicated).toBe(true);
    });
  });

  describe("processing a new file (R5, R7)", () => {
    it("answers 202 processing, then the chunks of a 3 page PDF are indexed with their metadata", async () => {
      const pdf = buildPdf([
        wrapLines(sentences("First page", 25)),
        wrapLines(sentences("Second page", 25)),
        wrapLines(sentences("Third page", 25)),
      ]);
      const response = await upload({ name: "plan.pdf", bytes: pdf, type: "application/pdf" });

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({
        name: "plan.pdf",
        kind: "pdf",
        sizeBytes: pdf.byteLength,
        status: "processing",
        deduplicated: false,
      });
      expect(response.body).not.toHaveProperty("contentHash");

      const done = await settled(response.body.id);

      expect(done).toMatchObject({ status: "ready", errorCode: null });
      expect(done.chunkCount).toBeGreaterThan(3);

      const chunks = await chunksOf(response.body.id);

      expect(chunks).toHaveLength(done.chunkCount);
      expect(new Set(chunks.map((chunk) => chunk.page))).toEqual(new Set([1, 2, 3]));
      expect(new Set(chunks.map((chunk) => chunk.sourceName))).toEqual(new Set(["plan.pdf"]));
      expect(chunks.map((chunk) => chunk.position).sort((a, b) => a - b)).toEqual(
        Array.from({ length: done.chunkCount }, (_, position) => position),
      );
      expect(leftoverWorkDirectories()).toEqual([]);
    });

    it.each([
      ["notes.txt", "Plain notes about the squad.\n\n".repeat(3)],
      ["readme.md", "# Title\n\nSome **markdown** about recovery.\n"],
    ])("indexes %s as text without a page", async (name, content) => {
      const response = await upload({ name, bytes: Buffer.from(content, "utf8") });
      const done = await settled(response.body.id);
      const chunks = await chunksOf(response.body.id);

      expect(done.status).toBe("ready");
      expect(chunks.length).toBe(done.chunkCount);
      expect(chunks.every((chunk) => !("page" in chunk))).toBe(true);
      expect(leftoverWorkDirectories()).toEqual([]);
    });
  });

  describe("deduplication (R3, R4)", () => {
    it("answers 200 deduplicated for the same bytes, without extracting, embedding or writing again", async () => {
      const bytes = Buffer.from(`Dedup content ${sentences("Dedup", 5)}`, "utf8");
      const first = await upload({ name: "first.txt", bytes });
      const firstDone = await settled(first.body.id);
      const embeddingCalls = embeddings.documentCalls;
      const upserts = index.upserts;
      const rowCount = (await rowsOf()).length;

      const second = await upload({ name: "renamed-copy.txt", bytes });

      expect(firstDone.status).toBe("ready");
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({
        id: first.body.id,
        deduplicated: true,
        status: "ready",
        name: "first.txt",
      });
      await processor.idle();
      expect(embeddings.documentCalls).toBe(embeddingCalls);
      expect(index.upserts).toBe(upserts);
      expect(await rowsOf()).toHaveLength(rowCount);
      expect(leftoverWorkDirectories()).toEqual([]);
    });

    it("processes the same file again for another user and keeps the bases apart", async () => {
      const bytes = Buffer.from(`Shared by two people ${sentences("Shared", 4)}`, "utf8");
      const other = await newUser("connections-other");
      const mine = await upload({ name: "same.txt", bytes });
      const theirs = await upload({ name: "same.txt", bytes }, other.token);

      await processor.idle();

      expect(theirs.status).toBe(202);
      expect(theirs.body.deduplicated).toBe(false);
      expect(theirs.body.id).not.toBe(mine.body.id);
      expect((await chunksOf(mine.body.id, userId)).length).toBeGreaterThan(0);
      expect(await chunksOf(mine.body.id, other.id)).toEqual([]);
      expect((await chunksOf(theirs.body.id, other.id)).length).toBeGreaterThan(0);
      expect(await chunksOf(theirs.body.id, userId)).toEqual([]);
    });

    it("resolves two simultaneous uploads of the same file into one row and one processing", async () => {
      const bytes = Buffer.from(`Simultaneous ${sentences("Race", 6)}`, "utf8");
      const racer = await newUser("connections-race");
      const [a, b] = await Promise.all([
        upload({ name: "a.txt", bytes }, racer.token),
        upload({ name: "b.txt", bytes }, racer.token),
      ]);

      await processor.idle();

      expect([a.status, b.status].every((code) => code === 200 || code === 202)).toBe(true);
      expect(a.body.id).toBe(b.body.id);
      expect(await rowsOf(racer.id)).toHaveLength(1);
      expect(embeddings.documentCalls).toBe(1);
      expect(index.upserts).toBe(1);
    });
  });

  describe("status and isolation (R7)", () => {
    it("shows the connection only to its owner", async () => {
      const upl = await upload({ name: "mine.txt", bytes: Buffer.from("private words") });
      const stranger = await newUser("connections-stranger");

      await processor.idle();

      expect((await status(upl.body.id)).status).toBe(200);

      for (const id of [upl.body.id, "5d3a5f4e-91f1-4b2c-8a1b-0e2f3a4b5c6d", "not-a-uuid"]) {
        const hidden = await status(id, stranger.token);

        expect(hidden.status).toBe(404);
        expect(hidden.body.error.code).toBe("CONNECTION_NOT_FOUND");
      }
    });

    it("turns a connection stuck in processing for 15 minutes into failed when asked", async () => {
      const upl = await upload({ name: "stuck.txt", bytes: Buffer.from("will get stuck") });

      await processor.idle();
      await query(
        "update public.connections set status = 'processing', error_code = null, updated_at = now() - interval '16 minutes' where id = $1",
        [upl.body.id],
      );

      const stale = await status(upl.body.id);

      expect(stale.body).toMatchObject({ status: "failed", errorCode: "PROCESSING_UNAVAILABLE" });
    });
  });

  describe("failures and compensation (R6)", () => {
    it("fails a PDF without text with NO_EXTRACTABLE_TEXT and leaves no chunk", async () => {
      const response = await upload({ name: "scan.pdf", bytes: buildPdf([[], []]) });
      const done = await settled(response.body.id);

      expect(done).toMatchObject({
        status: "failed",
        errorCode: "NO_EXTRACTABLE_TEXT",
        chunkCount: 0,
      });
      expect(await chunksOf(response.body.id)).toEqual([]);
      expect(leftoverWorkDirectories()).toEqual([]);
    });

    it("fails a protected PDF with PDF_PROTECTED", async () => {
      const response = await upload({ name: "locked.pdf", bytes: buildProtectedPdf() });
      const done = await settled(response.body.id);

      expect(done).toMatchObject({ status: "failed", errorCode: "PDF_PROTECTED" });
      expect(leftoverWorkDirectories()).toEqual([]);
    });

    it("fails a file with more than 2,000 chunks with TOO_MANY_CHUNKS, before any embedding", async () => {
      const text = Array.from(
        { length: 2100 },
        (_, number) => `P${number} ${"x".repeat(900)}`,
      ).join("\n\n");
      const response = await upload({ name: "huge.txt", bytes: Buffer.from(text, "utf8") });
      const done = await settled(response.body.id);

      expect(done).toMatchObject({ status: "failed", errorCode: "TOO_MANY_CHUNKS" });
      expect(embeddings.documentCalls).toBe(0);
    });

    it("removes the partial chunks when the index fails, and a new upload reprocesses to ready", async () => {
      const bytes = Buffer.from(`Compensation ${sentences("Comp", 30)}`, "utf8");

      index.failAfterWrite = true;

      const first = await upload({ name: "retry.txt", bytes });
      const failed = await settled(first.body.id);

      expect(failed).toMatchObject({ status: "failed", errorCode: "PROCESSING_UNAVAILABLE" });
      expect(await chunksOf(first.body.id)).toEqual([]);

      index.failAfterWrite = false;

      const again = await upload({ name: "retry.txt", bytes });

      expect(again.status).toBe(202);
      expect(again.body).toMatchObject({ id: first.body.id, deduplicated: false });

      const done = await settled(first.body.id);

      expect(done.status).toBe("ready");
      expect((await chunksOf(first.body.id)).length).toBe(done.chunkCount);
    });
  });

  describe("privacy (R9)", () => {
    it("never puts the file name, the content or the hash in a log, a span or a metric", async () => {
      const sentinel = "SENTINEL-doc-5e1f";
      const content = `${sentinel} ${sentences("Private", 5)}`;
      const bytes = Buffer.from(content, "utf8");
      const spies = [
        vi.spyOn(console, "log"),
        vi.spyOn(console, "error"),
        vi.spyOn(console, "warn"),
        vi.spyOn(baseLogger, "info"),
        vi.spyOn(baseLogger, "warn"),
        vi.spyOn(baseLogger, "error"),
      ];

      recorder.reset();

      try {
        const first = await upload({ name: `${sentinel}.txt`, bytes });

        await processor.idle();
        await upload({ name: `${sentinel}.txt`, bytes });
        await upload({ name: `${sentinel}-scan.pdf`, bytes: buildPdf([[]]) });
        await processor.idle();

        const emitted = JSON.stringify({
          // Everything the console received plus every structured event the code wrote. The
          // `pino-http` access log is left out: its serializers (id, method, path) run after the
          // call, so the spy would see the raw request object, which is not what gets written.
          logs: spies.flatMap((spy) => spy.mock.calls).filter((call) => !isAccessLog(call[0])),
          spans: recorder.exportedSpans(),
          ingestions: await recorder.metric("connection.ingestions"),
          durations: await recorder.metric("connection.ingestion.duration"),
        });

        for (const secret of [sentinel, sha256Of(bytes), first.body.id, userId]) {
          expect(emitted).not.toContain(secret);
        }

        expect(leftoverWorkDirectories()).toEqual([]);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });

    it("records the ingestion series with closed dimensions (R10)", async () => {
      recorder.reset();

      const bytes = Buffer.from(`Telemetry ${sentences("Tel", 3)}`, "utf8");

      await upload({ name: "tel.md", bytes });
      await processor.idle();
      await upload({ name: "tel-copy.md", bytes });
      await upload({ name: "tel-scan.pdf", bytes: buildPdf([[]]) });
      await processor.idle();

      const points = (await recorder.metric("connection.ingestions")).map((point) => ({
        ...point.attributes,
        value: point.value,
      }));

      expect(points).toEqual(
        expect.arrayContaining([
          { outcome: "success", kind: "md", deduplicated: false, value: 1 },
          { outcome: "success", kind: "md", deduplicated: true, value: 1 },
          { outcome: "failure", kind: "pdf", deduplicated: false, value: 1 },
        ]),
      );
      expect((await recorder.metric("connection.ingestion.duration")).length).toBeGreaterThan(0);
      expect(recorder.spans().some((span) => span.name === "connection.ingest")).toBe(true);
    });
  });

  afterEach(async () => {
    await processor.idle();
  });
});

function isAccessLog(first: unknown): boolean {
  return typeof first === "object" && first !== null && ("req" in first || "res" in first);
}

/** The digest the API takes as the identity of a file: SHA-256 of the raw bytes. */
function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
