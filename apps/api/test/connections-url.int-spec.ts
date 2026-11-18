import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/bootstrap";
import { SessionService } from "../src/modules/auth/application/services/session.service";
import { ConnectionProcessor } from "../src/modules/connections/application/services/connection-processor";
import { EMBEDDINGS_GENERATOR, KNOWLEDGE_INDEX } from "../src/modules/knowledge";
import { FakeEmbeddingsGenerator, fakeVectorOf } from "../src/modules/knowledge/testing";
import {
  createWeaviateConnector,
  WeaviateKnowledgeIndex,
} from "../src/modules/knowledge/infrastructure/weaviate-knowledge-index";
import { baseLogger } from "../src/observability/logger";
import { assertMigrationsApplied, deleteUsersByEmail, query, rows } from "./support/database";
import { resetRateLimitStore } from "./support/rate-limit";
import { seedConfirmedUser } from "./support/sessions";
import { startTelemetryRecorder, type TelemetryRecorder } from "./support/telemetry";
import { requireWeaviate, TEST_COLLECTION, weaviateTestConfig } from "./support/weaviate";

// With NODE_ENV=test the API reaches the web through the scripted resolver and transport (see
// `createScriptedWeb`), below the real egress protection: nothing leaves the machine, and
// `localhost`, private and metadata addresses are still refused by the guard itself.
const URL_PATH = "/api/v1/connections/url";
const CONNECTIONS_PATH = "/api/v1/connections";
const SECRET = "SEGREDO-TOKEN-42";
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const noWait = () => Promise.resolve();

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

describe("POST /api/v1/connections/url (Postgres and Weaviate local, scripted web, fake embeddings)", () => {
  const createdEmails: string[] = [];
  const createdUserIds: string[] = [];
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

    return { id: user.id, token: (await app.get(SessionService).issue(user.id)).accessToken };
  }

  const connect = (url: unknown, withToken: string | null = token) => {
    const call = request(app.getHttpServer()).post(URL_PATH).send({ url });

    return withToken === null ? call : call.set(bearer(withToken));
  };

  async function settled(id: string, withToken = token): Promise<ConnectionBody> {
    await processor.idle();

    return (
      await request(app.getHttpServer()).get(`${CONNECTIONS_PATH}/${id}`).set(bearer(withToken))
    ).body as ConnectionBody;
  }

  const chunksOf = (connectionId: string, forUser = userId) =>
    real.search(forUser, fakeVectorOf("anything"), { limit: 100, connectionIds: [connectionId] });

  const rowsOf = (forUser = userId) =>
    rows<{ id: string; kind: string; name: string; url_hash: string | null }>(
      "select id, kind, name, url_hash from public.connections where user_id = $1",
      [forUser],
    );

  beforeAll(async () => {
    await assertMigrationsApplied();
    await requireWeaviate();

    recorder = startTelemetryRecorder();
    real = new WeaviateKnowledgeIndex(createWeaviateConnector(weaviateTestConfig()), {
      collection: TEST_COLLECTION,
      wait: noWait,
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDINGS_GENERATOR)
      .useValue(new FakeEmbeddingsGenerator())
      .overrideProvider(KNOWLEDGE_INDEX)
      .useValue(real)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    processor = app.get(ConnectionProcessor, { strict: false });
    ({ id: userId, token } = await newUser("connections-url"));
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
  });

  afterEach(async () => {
    await processor.idle();
  });

  describe("request validation (R1)", () => {
    it("answers 401 without a session", async () => {
      expect((await connect("https://docs.example.test/regulation", null)).status).toBe(401);
    });

    it("answers 400 VALIDATION_FAILED for a link above 2,048 characters, a missing link and extra properties", async () => {
      const long = await connect(`https://docs.example.test/${"a".repeat(2030)}`);
      const missing = await request(app.getHttpServer()).post(URL_PATH).set(bearer(token)).send({});
      const extra = await request(app.getHttpServer())
        .post(URL_PATH)
        .set(bearer(token))
        .send({ url: "https://docs.example.test/regulation", userId });

      expect(long.status).toBe(400);
      expect(long.body.error.code).toBe("VALIDATION_FAILED");
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe("VALIDATION_FAILED");
      expect(extra.status).toBe(400);
      expect(extra.body.error.code).toBe("VALIDATION_FAILED");
    });

    it.each([
      ["ftp://docs.example.test/file"],
      ["file:///etc/passwd"],
      ["http://user:pw@docs.example.test/"],
      ["http://docs.example.test:5432/"],
      ["docs.example.test/regulation"],
    ])("answers 400 INVALID_URL for %s", async (url) => {
      const response = await connect(url);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("INVALID_URL");
      expect(await rowsOf()).toEqual([]);
    });

    it("answers 429 above 10 links in 10 minutes from the same IP", async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect((await connect("ftp://x.test/")).status).toBe(400);
      }

      const limited = await connect("ftp://x.test/");

      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe("RATE_LIMITED");
    });
  });

  describe("destinations that are not public (R2, R3)", () => {
    it.each([
      ["http://localhost"],
      ["http://localhost:80/admin"],
      ["http://127.0.0.1"],
      ["http://[::1]"],
      ["http://[::ffff:127.0.0.1]"],
      ["http://10.0.0.5"],
      ["http://192.168.1.1"],
      ["http://169.254.169.254/latest/meta-data/"],
      ["http://0x7f.1"],
      ["http://2130706433"],
      // A name the scripted resolver answers with 10.0.0.5.
      ["https://internal.example.test/regulation"],
    ])("answers 400 URL_NOT_ALLOWED for %s and creates nothing", async (url) => {
      const response = await connect(url);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("URL_NOT_ALLOWED");
      expect(await rowsOf()).toEqual([]);
    });

    it("refuses a redirect to the metadata address", async () => {
      const response = await connect("https://docs.example.test/to-metadata");

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("URL_NOT_ALLOWED");
      expect(await rowsOf()).toEqual([]);
    });
  });

  describe("a public page (R4, R5, R6, R7, R8)", () => {
    it("answers 202, indexes only the text of the article and names the connection by the title", async () => {
      const response = await connect(
        `https://docs.example.test/regulation?token=${SECRET}#section`,
      );

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({
        name: "Match regulation 2026",
        kind: "url",
        status: "processing",
        deduplicated: false,
      });
      expect(response.body).not.toHaveProperty("url");
      expect(response.body).not.toHaveProperty("urlHash");
      expect(response.body).not.toHaveProperty("contentHash");

      const done = await settled(response.body.id);

      expect(done).toMatchObject({ status: "ready", errorCode: null });

      const text = (await chunksOf(response.body.id)).map((chunk) => chunk.text).join("\n");

      expect(text).toContain("Substitutions are limited to five per match");
      for (const noise of ["MENU-NOISE", "FOOTER-NOISE", "SCRIPT-NOISE"]) {
        expect(text).not.toContain(noise);
      }

      const [row] = await rowsOf();

      expect(row).toMatchObject({ kind: "url", name: "Match regulation 2026" });
      expect(row?.url_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(
        JSON.stringify(
          await query("select * from public.connections where user_id = $1", [userId]).then(
            (result) => result.rows,
          ),
        ),
      ).not.toContain(SECRET);
    });

    it("follows a safe redirect to the end", async () => {
      const other = await newUser("connections-url-redirect");
      const response = await connect("https://docs.example.test/moved", other.token);

      expect(response.status).toBe(202);
      expect((await settled(response.body.id, other.token)).status).toBe("ready");
    });

    it("deduplicates the same link with a fragment, tracking and a trailing slash, without a new request", async () => {
      const other = await newUser("connections-url-dedup");
      const first = await connect("https://docs.example.test/regulation", other.token);

      await settled(first.body.id, other.token);

      const again = await connect(
        "https://DOCS.example.test/regulation/?utm_source=newsletter#clause-2",
        other.token,
      );

      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ id: first.body.id, deduplicated: true, status: "ready" });
      expect(await rowsOf(other.id)).toHaveLength(1);
    });

    it("deduplicates two different links with the same text and writes no new vectors", async () => {
      const other = await newUser("connections-url-content");
      const first = await connect("https://docs.example.test/regulation", other.token);

      await settled(first.body.id, other.token);

      const before = (await chunksOf(first.body.id, other.id)).length;
      const mirror = await connect("https://mirror.example.test/regulation", other.token);

      expect(mirror.status).toBe(200);
      expect(mirror.body).toMatchObject({ id: first.body.id, deduplicated: true });
      expect(await rowsOf(other.id)).toHaveLength(1);
      expect((await chunksOf(first.body.id, other.id)).length).toBe(before);
    });

    it("processes the same link again for another user and keeps the bases apart", async () => {
      const mine = await connect("https://docs.example.test/regulation");
      const other = await newUser("connections-url-other");
      const theirs = await connect("https://docs.example.test/regulation", other.token);

      await processor.idle();

      expect(theirs.status).toBe(202);
      expect(theirs.body.id).not.toBe(mine.body.id);
      expect(await chunksOf(mine.body.id, other.id)).toEqual([]);
      expect((await chunksOf(theirs.body.id, other.id)).length).toBeGreaterThan(0);
    });

    it("resolves two simultaneous requests for the same link into one connection", async () => {
      const racer = await newUser("connections-url-race");
      const [a, b] = await Promise.all([
        connect("https://docs.example.test/regulation", racer.token),
        connect("https://docs.example.test/regulation", racer.token),
      ]);

      await processor.idle();

      expect([a.status, b.status].every((code) => code === 200 || code === 202)).toBe(true);
      expect(a.body.id).toBe(b.body.id);
      expect(await rowsOf(racer.id)).toHaveLength(1);
    });

    it("lists the link with kind url and deletes it completely", async () => {
      const owner = await newUser("connections-url-delete");
      const created = await connect("https://docs.example.test/regulation", owner.token);

      await settled(created.body.id, owner.token);

      const list = await request(app.getHttpServer())
        .get(CONNECTIONS_PATH)
        .set(bearer(owner.token));

      expect(list.body.connections).toEqual([
        expect.objectContaining({
          id: created.body.id,
          kind: "url",
          name: "Match regulation 2026",
        }),
      ]);

      const removed = await request(app.getHttpServer())
        .delete(`${CONNECTIONS_PATH}/${created.body.id}`)
        .set(bearer(owner.token));

      expect(removed.status).toBe(204);
      expect(await chunksOf(created.body.id, owner.id)).toEqual([]);
      expect(await rowsOf(owner.id)).toEqual([]);
    });
  });

  describe("pages that cannot be used create no connection (R4, R5)", () => {
    it.each([
      ["https://docs.example.test/script-only", "NO_EXTRACTABLE_TEXT"],
      ["https://docs.example.test/image", "UNSUPPORTED_CONTENT_TYPE"],
      ["https://docs.example.test/does-not-exist", "FETCH_FAILED"],
      ["https://unknown.example.test/page", "FETCH_FAILED"],
    ])("answers 422 for %s -> %s", async (url, code) => {
      const fresh = await newUser("connections-url-unusable");
      const response = await connect(url, fresh.token);

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe(code);
      expect(await rowsOf(fresh.id)).toEqual([]);
    });
  });

  describe("limits and secrets (R1, R7, R10)", () => {
    it("refuses the 51st connection with 409 before any request", async () => {
      const limited = await newUser("connections-url-limit");

      for (let number = 0; number < 50; number += 1) {
        await query(
          `insert into public.connections (user_id, kind, name, size_bytes, content_hash, status, chunk_count)
           values ($1, 'txt', $2, 10, $3, 'ready', 1)`,
          [limited.id, `seed-${number}.txt`, number.toString(16).padStart(64, "0")],
        );
      }

      const response = await connect("https://docs.example.test/regulation", limited.token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("CONNECTION_LIMIT_REACHED");
    });

    it("keeps a unique link per user in the database", async () => {
      const hash = "a".repeat(64);
      const insert = (name: string, content: string, kind = "url") =>
        query(
          `insert into public.connections (user_id, kind, name, size_bytes, content_hash, url_hash, status)
           values ($1, $4, $2, 5, $3, $5, 'processing')`,
          [userId, name, content, kind, kind === "url" ? hash : null],
        );
      const other = await newUser("connections-url-unique");

      await query("delete from public.connections where user_id = $1 and url_hash = $2", [
        userId,
        hash,
      ]);
      await insert("one", "b".repeat(64));
      await expect(insert("two", "c".repeat(64))).rejects.toMatchObject({ code: "23505" });
      await query(
        `insert into public.connections (user_id, kind, name, size_bytes, content_hash, url_hash, status)
         values ($1, 'url', 'same link, other user', 5, $2, $3, 'processing')`,
        [other.id, "d".repeat(64), hash],
      );
      await expect(
        query(
          `insert into public.connections (user_id, kind, name, size_bytes, content_hash, url_hash, status)
           values ($1, 'url', 'bad hash', 5, $2, 'not-a-hash', 'processing')`,
          [userId, "e".repeat(64)],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await query("delete from public.connections where user_id = any($1)", [[userId, other.id]]);
    });

    it("never lets the secret of a link, its host or the page text reach logs, spans or metrics", async () => {
      const spies = [
        vi.spyOn(console, "log"),
        vi.spyOn(console, "error"),
        vi.spyOn(console, "warn"),
        vi.spyOn(baseLogger, "info"),
        vi.spyOn(baseLogger, "warn"),
        vi.spyOn(baseLogger, "error"),
      ];
      const watcher = await newUser("connections-url-secrets");

      recorder.reset();

      try {
        const ok = await connect(
          `https://docs.example.test/regulation?token=${SECRET}#a`,
          watcher.token,
        );

        await processor.idle();
        await connect(`http://169.254.169.254/?token=${SECRET}`, watcher.token);
        await connect(`https://docs.example.test/does-not-exist?token=${SECRET}`, watcher.token);
        await connect(`ftp://docs.example.test/?token=${SECRET}`, watcher.token);

        const emitted = JSON.stringify({
          logs: spies
            .flatMap((spy) => spy.mock.calls)
            .filter(
              (call) =>
                !(
                  typeof call[0] === "object" &&
                  call[0] !== null &&
                  ("req" in call[0] || "res" in call[0])
                ),
            ),
          spans: recorder.exportedSpans(),
          ingestions: await recorder.metric("connection.ingestions"),
          blocked: await recorder.metric("url_fetch.blocked"),
          fetches: await recorder.metric("url_fetch.duration"),
        });

        for (const secret of [
          SECRET,
          "docs.example.test",
          "169.254.169.254",
          "Substitutions are limited",
          ok.body.id,
          watcher.id,
        ]) {
          expect(emitted).not.toContain(secret);
        }
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });

    it("records the series with closed dimensions", async () => {
      const watcher = await newUser("connections-url-series");

      recorder.reset();
      await connect("https://docs.example.test/regulation", watcher.token);
      await processor.idle();
      await connect("http://localhost/", watcher.token);
      await connect("ftp://docs.example.test/", watcher.token);
      await connect("https://docs.example.test/to-metadata", watcher.token);

      const blocked = (await recorder.metric("url_fetch.blocked")).map((point) => ({
        ...point.attributes,
        value: point.value,
      }));
      const fetches = (await recorder.metric("url_fetch.duration")).map(
        (point) => point.attributes,
      );
      const ingestions = (await recorder.metric("connection.ingestions")).map(
        (point) => point.attributes,
      );

      expect(blocked).toEqual(
        expect.arrayContaining([
          { reason: "address", value: 1 },
          { reason: "scheme", value: 1 },
          { reason: "redirect", value: 1 },
        ]),
      );
      expect(fetches).toEqual(
        expect.arrayContaining([{ outcome: "success" }, { outcome: "blocked" }]),
      );
      expect(ingestions).toEqual(
        expect.arrayContaining([
          { outcome: "success", kind: "url", deduplicated: false },
          { outcome: "failure", kind: "url", deduplicated: false },
        ]),
      );
    });
  });
});
