import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EmbeddingsUnavailableError,
  type EmbeddingsGenerator,
  KnowledgeIndexUnavailableError,
  type KnowledgeIndex,
} from "../../../knowledge";
import { FakeEmbeddingsGenerator, InMemoryKnowledgeIndex } from "../../../knowledge/testing";
import type { Connection } from "../../domain/connection";
import { ConnectionProcessingError } from "../../domain/connection-errors";
import type {
  ConnectionTelemetry,
  DocumentExtractor,
  ExtractedSection,
  IngestionResult,
  TextChunker,
} from "../../domain/connection-ports";
import { MAX_CHUNKS_PER_CONNECTION } from "../../domain/connection-rules";
import { RecursiveTextChunker } from "../../infrastructure/recursive-text-chunker";
import { InMemoryConnectionRepository } from "../../testing/in-memory-connection.repository";
import { ConnectionProcessor } from "./connection-processor";

const USER_ID = randomUUID();
const OTHER_USER_ID = randomUUID();
const SENTINEL = "SENTINEL-doc-text-77";

class RecordingTelemetry implements ConnectionTelemetry {
  readonly results: IngestionResult[] = [];

  async traceIngestion(
    _kind: Connection["kind"],
    run: () => Promise<IngestionResult>,
  ): Promise<IngestionResult> {
    const result = await run();

    this.results.push(result);

    return result;
  }

  recordDeduplicated(): void {}

  recordDeletion(): void {}
}

function setup(
  options: {
    sections?: ExtractedSection[] | (() => Promise<ExtractedSection[]>);
    embeddings?: EmbeddingsGenerator;
    index?: KnowledgeIndex;
    chunker?: TextChunker;
    mediaChunker?: TextChunker;
    extractionTimeoutMs?: number;
    mediaExtractionTimeoutMs?: number;
    concurrency?: number;
    mediaConcurrency?: number;
    maxWaitingMediaJobs?: number;
  } = {},
) {
  const repository = new InMemoryConnectionRepository();
  const index = options.index ?? new InMemoryKnowledgeIndex();
  const embeddings = options.embeddings ?? new FakeEmbeddingsGenerator();
  const telemetry = new RecordingTelemetry();
  const sections = options.sections ?? [{ text: `${SENTINEL} first.` }];
  const extract = vi.fn(async () => (typeof sections === "function" ? sections() : sections));
  const extractor: DocumentExtractor = { extract };
  const processor = new ConnectionProcessor({
    repository,
    extractors: {
      pdf: extractor,
      txt: extractor,
      md: extractor,
      audio: extractor,
      video: extractor,
    },
    chunker: options.chunker ?? new RecursiveTextChunker(),
    embeddings,
    index,
    telemetry,
    mediaChunker: options.mediaChunker,
    extractionTimeoutMs: options.extractionTimeoutMs,
    mediaExtractionTimeoutMs: options.mediaExtractionTimeoutMs,
    concurrency: options.concurrency,
    mediaConcurrency: options.mediaConcurrency,
    maxWaitingMediaJobs: options.maxWaitingMediaJobs,
  });

  async function connect(kind: Connection["kind"] = "pdf", userId = USER_ID) {
    const { connection } = await repository.insertProcessing(userId, {
      kind,
      name: "plan.pdf",
      sizeBytes: 10,
      contentHash: randomUUID().replaceAll("-", "").repeat(2),
    });

    return connection;
  }

  const hitsOf = (connectionId: string, userId = USER_ID) =>
    index.search(
      userId,
      Array.from({ length: 1536 }, () => 0.01),
      {
        limit: 100,
        connectionIds: [connectionId],
      },
    );

  return { processor, repository, index, extract, telemetry, connect, hitsOf };
}

describe("ConnectionProcessor", () => {
  it("indexes the chunks with their metadata and marks the connection ready (R5)", async () => {
    const { processor, repository, connect, hitsOf } = setup({
      sections: [
        { text: "Page one text.", page: 1 },
        { text: "Page two text.", page: 2 },
      ],
    });
    const connection = await connect();

    processor.enqueue({ userId: USER_ID, connection, bytes: Buffer.from("x"), clearFirst: false });
    await processor.idle();

    const hits = await hitsOf(connection.id);

    expect(hits.map((hit) => [hit.position, hit.page, hit.sourceName]).sort()).toEqual([
      [0, 1, "plan.pdf"],
      [1, 2, "plan.pdf"],
    ]);
    expect(repository.rows.get(connection.id)).toMatchObject({ status: "ready", chunkCount: 2 });
  });

  it("indexes text without a page", async () => {
    const { processor, connect, hitsOf } = setup({ sections: [{ text: "Plain markdown." }] });
    const connection = await connect("md");

    processor.enqueue({ userId: USER_ID, connection, bytes: Buffer.from("x"), clearFirst: false });
    await processor.idle();

    const [hit] = await hitsOf(connection.id);

    expect(hit).toBeDefined();
    expect(hit && "page" in hit).toBe(false);
  });

  it("writes only into the tenant of the user", async () => {
    const { processor, connect, hitsOf } = setup();
    const connection = await connect();

    processor.enqueue({ userId: USER_ID, connection, bytes: Buffer.from("x"), clearFirst: false });
    await processor.idle();

    expect(await hitsOf(connection.id, OTHER_USER_ID)).toEqual([]);
  });

  it("fails with NO_EXTRACTABLE_TEXT when nothing could be extracted, with no chunk left (R6)", async () => {
    const { processor, repository, connect, hitsOf, telemetry } = setup({ sections: [] });
    const connection = await connect();

    processor.enqueue({ userId: USER_ID, connection, bytes: Buffer.from("x"), clearFirst: false });
    await processor.idle();

    expect(repository.rows.get(connection.id)).toMatchObject({
      status: "failed",
      errorCode: "NO_EXTRACTABLE_TEXT",
    });
    expect(await hitsOf(connection.id)).toEqual([]);
    expect(telemetry.results).toEqual([
      { outcome: "failure", reason: "no_extractable_text", deduplicated: false, chunkCount: 0 },
    ]);
  });

  it("keeps the code of the extractor (a protected PDF)", async () => {
    const { processor, repository, connect } = setup({
      sections: () => Promise.reject(new ConnectionProcessingError("PDF_PROTECTED")),
    });
    const connection = await connect();

    processor.enqueue({ userId: USER_ID, connection, bytes: Buffer.from("x"), clearFirst: false });
    await processor.idle();

    expect(repository.rows.get(connection.id)).toMatchObject({
      status: "failed",
      errorCode: "PDF_PROTECTED",
    });
  });

  it("fails with TOO_MANY_CHUNKS before spending any embedding", async () => {
    const embedDocuments = vi.fn();
    const { processor, repository, connect } = setup({
      chunker: {
        chunk: () =>
          Promise.resolve(
            Array.from({ length: MAX_CHUNKS_PER_CONNECTION + 1 }, (_, i) => ({ text: `c${i}` })),
          ),
      },
      embeddings: { embedDocuments, embedQuery: vi.fn() },
    });
    const connection = await connect();

    processor.enqueue({ userId: USER_ID, connection, bytes: Buffer.from("x"), clearFirst: false });
    await processor.idle();

    expect(embedDocuments).not.toHaveBeenCalled();
    expect(repository.rows.get(connection.id)).toMatchObject({
      status: "failed",
      errorCode: "TOO_MANY_CHUNKS",
    });
  });

  it("fails with PROCESSING_UNAVAILABLE when the embeddings provider is down", async () => {
    const { processor, repository, connect, hitsOf } = setup({
      embeddings: {
        embedDocuments: () =>
          Promise.reject(new EmbeddingsUnavailableError("PROVIDER_ERROR", true)),
        embedQuery: vi.fn(),
      },
    });
    const connection = await connect();

    processor.enqueue({ userId: USER_ID, connection, bytes: Buffer.from("x"), clearFirst: false });
    await processor.idle();

    expect(repository.rows.get(connection.id)).toMatchObject({
      status: "failed",
      errorCode: "PROCESSING_UNAVAILABLE",
    });
    expect(await hitsOf(connection.id)).toEqual([]);
  });

  it("removes the vectors already written when the index fails half way (R6)", async () => {
    const memory = new InMemoryKnowledgeIndex();
    const failingAfterWrite: KnowledgeIndex = {
      upsert: async (userId, chunks) => {
        await memory.upsert(userId, chunks);
        throw new KnowledgeIndexUnavailableError("CONNECTION", true);
      },
      search: (userId, vector, options) => memory.search(userId, vector, options),
      deleteByConnection: (userId, id) => memory.deleteByConnection(userId, id),
      deleteAllForUser: (userId) => memory.deleteAllForUser(userId),
    };
    const { processor, repository, connect, hitsOf } = setup({ index: failingAfterWrite });
    const connection = await connect();

    processor.enqueue({ userId: USER_ID, connection, bytes: Buffer.from("x"), clearFirst: false });
    await processor.idle();

    expect(await hitsOf(connection.id)).toEqual([]);
    expect(repository.rows.get(connection.id)).toMatchObject({
      status: "failed",
      errorCode: "PROCESSING_UNAVAILABLE",
    });
  });

  it("gives up an extraction that takes too long", async () => {
    const { processor, repository, connect } = setup({
      sections: () => new Promise(() => undefined),
      extractionTimeoutMs: 20,
    });
    const connection = await connect();

    processor.enqueue({ userId: USER_ID, connection, bytes: Buffer.from("x"), clearFirst: false });
    await processor.idle();

    expect(repository.rows.get(connection.id)).toMatchObject({
      status: "failed",
      errorCode: "PROCESSING_UNAVAILABLE",
    });
  });

  it("clears leftovers of an earlier attempt before writing again when asked", async () => {
    const { processor, repository, index, connect, hitsOf } = setup({
      sections: [{ text: "Only chunk." }],
    });
    const connection = await connect();
    const staleText = "stale chunk from a failed run";

    await index.upsert(USER_ID, [
      {
        connectionId: connection.id,
        sourceName: "plan.pdf",
        position: 5,
        text: staleText,
        vector: await new FakeEmbeddingsGenerator().embedQuery(staleText),
      },
    ]);
    await repository.markFailed(USER_ID, connection.id, "PROCESSING_UNAVAILABLE");

    const claimed = await repository.claimFailed(USER_ID, connection.id);

    processor.enqueue({
      userId: USER_ID,
      connection: claimed ?? connection,
      bytes: Buffer.from("x"),
      clearFirst: true,
    });
    await processor.idle();

    expect((await hitsOf(connection.id)).map((hit) => hit.position)).toEqual([0]);
  });

  it("runs at most `concurrency` jobs at once and finishes them all", async () => {
    let active = 0;
    let peak = 0;
    const { processor, connect } = setup({
      concurrency: 2,
      sections: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;

        return [{ text: "text" }];
      },
    });

    for (let count = 0; count < 5; count += 1) {
      processor.enqueue({
        userId: USER_ID,
        connection: await connect(),
        bytes: Buffer.from("x"),
        clearFirst: false,
      });
    }

    await processor.idle();

    expect(peak).toBe(2);
  });

  it("never lets the file content reach the error codes or the telemetry result", async () => {
    const { processor, telemetry, connect } = setup({
      sections: () => Promise.reject(new Error(`could not read ${SENTINEL}`)),
    });
    const connection = await connect();

    processor.enqueue({ userId: USER_ID, connection, bytes: Buffer.from("x"), clearFirst: false });
    await processor.idle();

    expect(JSON.stringify(telemetry.results)).not.toContain(SENTINEL);
  });
});
