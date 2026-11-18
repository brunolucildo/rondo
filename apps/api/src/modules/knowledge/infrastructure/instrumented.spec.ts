import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { baseLogger } from "../../../observability/logger";
import { startTelemetryRecorder, type TelemetryRecorder } from "../../../../test/support/telemetry";
import { chunkOf } from "../../../../test/support/knowledge-index-contract";
import type { EmbeddingsGenerator } from "../domain/embeddings-generator";
import {
  EmbeddingsUnavailableError,
  KnowledgeIndexUnavailableError,
} from "../domain/knowledge-errors";
import type { KnowledgeIndex } from "../domain/knowledge-index";
import { tenantNameOf } from "../domain/knowledge-rules";
import { fakeVectorOf } from "./fake-embeddings-generator";
import { InMemoryKnowledgeIndex } from "./in-memory-knowledge-index";
import { InstrumentedEmbeddingsGenerator, InstrumentedKnowledgeIndex } from "./instrumented";

const SENTINEL_TEXT = "SENTINEL-chunk-text-7731";
const USER_ID = randomUUID();
const CONNECTION_ID = randomUUID();

describe("knowledge telemetry (R8)", () => {
  let recorder: TelemetryRecorder;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    recorder = startTelemetryRecorder();
  });

  afterAll(async () => {
    await recorder.stop();
  });

  beforeEach(() => {
    recorder.reset();
    infoSpy = vi.spyOn(baseLogger, "info").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(baseLogger, "warn").mockImplementation(() => undefined);
  });

  const everythingEmitted = async (): Promise<string> =>
    JSON.stringify([
      recorder.exportedSpans(),
      await recorder.metric("knowledge.index.operation.duration"),
      await recorder.metric("knowledge.embeddings.duration"),
      await recorder.metric("knowledge.embeddings.texts"),
      infoSpy.mock.calls,
      warnSpy.mock.calls,
    ]);

  it("records a duration, a span and one log line per index operation, without content", async () => {
    const index = new InstrumentedKnowledgeIndex(new InMemoryKnowledgeIndex());

    await index.upsert(USER_ID, [
      chunkOf(CONNECTION_ID, 0, SENTINEL_TEXT, { sourceName: "secret-name.pdf" }),
    ]);
    await index.search(USER_ID, fakeVectorOf(SENTINEL_TEXT), { limit: 3 });
    await index.deleteByConnection(USER_ID, CONNECTION_ID);
    await index.deleteAllForUser(USER_ID);

    const points = await recorder.metric("knowledge.index.operation.duration");

    expect(
      points
        .map((point) => point.attributes)
        .sort((a, b) => String(a.operation).localeCompare(String(b.operation))),
    ).toEqual([
      { operation: "delete_all_for_user", outcome: "success" },
      { operation: "delete_by_connection", outcome: "success" },
      { operation: "search", outcome: "success" },
      { operation: "upsert", outcome: "success" },
    ]);
    expect(
      recorder
        .spans()
        .map((span) => span.name)
        .sort(),
    ).toEqual([
      "knowledge.index.delete_all_for_user",
      "knowledge.index.delete_by_connection",
      "knowledge.index.search",
      "knowledge.index.upsert",
    ]);
    expect(infoSpy).toHaveBeenCalledTimes(4);
    expect(infoSpy.mock.calls[0]?.[0]).toMatchObject({
      event: "knowledge_index_operation",
      operation: "upsert",
      outcome: "success",
      reason: "none",
    });

    const emitted = await everythingEmitted();

    for (const secret of [
      SENTINEL_TEXT,
      USER_ID,
      CONNECTION_ID,
      "secret-name.pdf",
      tenantNameOf(USER_ID),
    ]) {
      expect(emitted).not.toContain(secret);
    }
  });

  it("marks a failed operation with the closed reason, never with the error text", async () => {
    const failing: KnowledgeIndex = {
      upsert: () => Promise.reject(new KnowledgeIndexUnavailableError("CONNECTION", true, 3)),
      search: () => Promise.reject(new Error(`boom ${SENTINEL_TEXT} ${USER_ID}`)),
      deleteByConnection: () => Promise.resolve(),
      deleteAllForUser: () => Promise.resolve(),
    };
    const index = new InstrumentedKnowledgeIndex(failing);

    await expect(index.upsert(USER_ID, [chunkOf(CONNECTION_ID, 0, SENTINEL_TEXT)])).rejects.toThrow(
      KnowledgeIndexUnavailableError,
    );
    await expect(index.search(USER_ID, fakeVectorOf("x"), { limit: 1 })).rejects.toThrow("boom");

    const points = await recorder.metric("knowledge.index.operation.duration");

    expect(points.map((point) => point.attributes)).toEqual(
      expect.arrayContaining([
        { operation: "upsert", outcome: "failure" },
        { operation: "search", outcome: "failure" },
      ]),
    );
    expect(
      warnSpy.mock.calls
        .map((call: unknown[]) => call[0] as { event: string; reason: string })
        .filter((fields: { event: string }) => fields.event === "knowledge_index_operation")
        .map((fields: { reason: string }) => fields.reason)
        .sort(),
    ).toEqual(["connection", "unknown"]);
    expect(recorder.spans().every((span) => span.status.code === 2)).toBe(true);
    expect(recorder.spans().flatMap((span) => span.events)).toEqual([]);

    const emitted = await everythingEmitted();

    for (const secret of [SENTINEL_TEXT, USER_ID, CONNECTION_ID, "boom"]) {
      expect(emitted).not.toContain(secret);
    }
  });

  it("records the embeddings duration and the number of texts, by outcome", async () => {
    const generator: EmbeddingsGenerator = {
      embedDocuments: (texts) => Promise.resolve(texts.map(() => [0])),
      embedQuery: () => Promise.reject(new EmbeddingsUnavailableError("RATE_LIMITED", true, 3)),
    };
    const instrumented = new InstrumentedEmbeddingsGenerator(generator);

    await instrumented.embedDocuments([SENTINEL_TEXT, "b", "c"]);
    await expect(instrumented.embedQuery(SENTINEL_TEXT)).rejects.toThrow(
      EmbeddingsUnavailableError,
    );

    const durations = await recorder.metric("knowledge.embeddings.duration");
    const texts = await recorder.metric("knowledge.embeddings.texts");

    expect(
      durations
        .map((point) => point.attributes)
        .sort((a, b) => String(a.outcome).localeCompare(String(b.outcome))),
    ).toEqual([{ outcome: "failure" }, { outcome: "success" }]);
    expect(texts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: { outcome: "success" }, value: 3 }),
        expect.objectContaining({ attributes: { outcome: "failure" }, value: 1 }),
      ]),
    );
    expect(infoSpy.mock.calls[0]?.[0]).toMatchObject({
      event: "knowledge_embeddings_request",
      outcome: "success",
      texts: 3,
    });
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ reason: "rate_limited", texts: 1 });
    expect(await everythingEmitted()).not.toContain(SENTINEL_TEXT);
  });
});
