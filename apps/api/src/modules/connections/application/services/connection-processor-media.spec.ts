import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeEmbeddingsGenerator, InMemoryKnowledgeIndex } from "../../../knowledge/testing";
import type { Connection } from "../../domain/connection";
import type {
  ConnectionTelemetry,
  DocumentExtractor,
  IngestionResult,
} from "../../domain/connection-ports";
import { FakeMediaUnderstanding } from "../../infrastructure/fake-media-understanding";
import { MediaDocumentExtractor } from "../../infrastructure/media-document-extractor";
import { RecursiveTextChunker } from "../../infrastructure/recursive-text-chunker";
import { TimedTextChunker } from "../../infrastructure/timed-text-chunker";
import { InMemoryConnectionRepository } from "../../testing/in-memory-connection.repository";
import { buildMp3, buildMp4 } from "../../testing/media-fixtures";
import { ConnectionProcessor } from "./connection-processor";

const USER_ID = randomUUID();

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
  recordUrlFetch(): void {}
  recordRejected(): void {}
}

function setup(
  options: {
    documentExtractor?: DocumentExtractor;
    mediaTimeoutMs?: number;
    mediaConcurrency?: number;
    maxWaitingMediaJobs?: number;
  } = {},
) {
  const repository = new InMemoryConnectionRepository();
  const index = new InMemoryKnowledgeIndex();
  const media = new FakeMediaUnderstanding();
  const telemetry = new RecordingTelemetry();
  const documents: DocumentExtractor = options.documentExtractor ?? {
    extract: () => Promise.resolve([{ text: "A document." }]),
  };
  const processor = new ConnectionProcessor({
    repository,
    extractors: {
      pdf: documents,
      txt: documents,
      md: documents,
      image: documents,
      audio: new MediaDocumentExtractor("audio", media),
      video: new MediaDocumentExtractor("video", media),
    },
    chunker: new RecursiveTextChunker(),
    mediaChunker: new TimedTextChunker(),
    embeddings: new FakeEmbeddingsGenerator(),
    index,
    telemetry,
    mediaExtractionTimeoutMs: options.mediaTimeoutMs,
    mediaConcurrency: options.mediaConcurrency,
    maxWaitingMediaJobs: options.maxWaitingMediaJobs,
  });

  async function connect(kind: Connection["kind"], durationSeconds: number | null = 60) {
    const { connection } = await repository.insertProcessing(USER_ID, {
      kind,
      name: "analysis.mp4",
      sizeBytes: 10,
      durationSeconds,
      contentHash: randomUUID().replaceAll("-", "").repeat(2),
    });

    return connection;
  }

  const hitsOf = (connectionId: string) =>
    index.search(
      USER_ID,
      Array.from({ length: 1536 }, () => 0.01),
      { limit: 100, connectionIds: [connectionId] },
    );

  return { processor, repository, index, media, telemetry, connect, hitsOf };
}

describe("ConnectionProcessor with audio and video (spec 0028)", () => {
  it("indexes the transcript with the start of each chunk and marks the audio ready (R3)", async () => {
    const { processor, repository, connect, hitsOf, media } = setup();
    const connection = await connect("audio");
    const script = [
      `[00:05] ${"Opening words. ".repeat(40)}`,
      `[12:30] ${"The exit from the back starts here. ".repeat(14)}`,
    ].join("\n");

    processor.enqueue({
      userId: USER_ID,
      connection,
      bytes: buildMp3({ script }),
      clearFirst: false,
    });
    await processor.idle();

    const hits = await hitsOf(connection.id);

    expect(hits.map((hit) => hit.startSeconds).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      5, 750,
    ]);
    expect(hits.every((hit) => hit.page === undefined && hit.sourceName === "analysis.mp4")).toBe(
      true,
    );
    expect(repository.rows.get(connection.id)).toMatchObject({ status: "ready", chunkCount: 2 });
    expect(media.uploads).toBe(media.deletions);
  });

  it("indexes the description of the scenes of a video next to the speech (R3)", async () => {
    const { processor, connect, hitsOf } = setup();
    const connection = await connect("video");
    const script = "[00:03] The coach speaks.\n[00:10] SCENE: the scoreboard reads 2-1.";

    processor.enqueue({
      userId: USER_ID,
      connection,
      bytes: buildMp4({ script }),
      clearFirst: false,
    });
    await processor.idle();

    const [hit] = await hitsOf(connection.id);

    expect(hit?.text).toContain("SCENE: the scoreboard reads 2-1.");
    expect(hit?.startSeconds).toBe(3);
  });

  it.each([
    ["NO_CONTENT", "NO_EXTRACTABLE_TEXT"],
    ["UNREADABLE", "MEDIA_UNREADABLE"],
    ["REFUSED", "CONTENT_NOT_PROCESSABLE"],
    ["UNAVAILABLE", "PROCESSING_UNAVAILABLE"],
  ] as const)("fails with %s as %s and leaves no partial chunk (R6)", async (fail, code) => {
    const { processor, repository, connect, hitsOf, telemetry } = setup();
    const connection = await connect("video");

    processor.enqueue({
      userId: USER_ID,
      connection,
      bytes: buildMp4({ fail }),
      clearFirst: false,
    });
    await processor.idle();

    expect(repository.rows.get(connection.id)).toMatchObject({ status: "failed", errorCode: code });
    expect(await hitsOf(connection.id)).toEqual([]);
    expect(telemetry.results[0]).toMatchObject({
      outcome: "failure",
      reason: code.toLowerCase(),
      mediaSeconds: 60,
    });
  });

  it("reports the seconds of media processed, and nothing for a document (R10)", async () => {
    const { processor, connect, telemetry } = setup();
    const audio = await connect("audio", 300);
    const text = await connect("txt", null);

    processor.enqueue({ userId: USER_ID, connection: audio, bytes: buildMp3(), clearFirst: false });
    processor.enqueue({
      userId: USER_ID,
      connection: text,
      bytes: Buffer.from("x"),
      clearFirst: false,
    });
    await processor.idle();

    const byKind = telemetry.results.map((result) => result.mediaSeconds);

    expect(byKind).toContain(300);
    expect(byKind).toContain(undefined);
  });

  it("fails a media that outlasts its own, longer, timeout with PROCESSING_UNAVAILABLE (R5)", async () => {
    const { processor, repository, connect, media } = setup({ mediaTimeoutMs: 20 });
    const connection = await connect("audio");

    media.hold = new Promise(() => undefined);
    processor.enqueue({ userId: USER_ID, connection, bytes: buildMp3(), clearFirst: false });
    await processor.idle();

    expect(repository.rows.get(connection.id)).toMatchObject({
      status: "failed",
      errorCode: "PROCESSING_UNAVAILABLE",
    });
  });

  it("keeps the media in a lane of its own, so a long media does not hold up a PDF (R5)", async () => {
    const { processor, repository, connect, media } = setup({ mediaConcurrency: 1 });
    let release: () => void = () => undefined;

    media.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow = await connect("video");
    const pdf = await connect("pdf", null);

    processor.enqueue({ userId: USER_ID, connection: slow, bytes: buildMp4(), clearFirst: false });
    processor.enqueue({
      userId: USER_ID,
      connection: pdf,
      bytes: Buffer.from("x"),
      clearFirst: false,
    });

    await waitFor(() => repository.rows.get(pdf.id)?.status === "ready");

    expect(repository.rows.get(slow.id)?.status).toBe("processing");

    release();
    await processor.idle();

    expect(repository.rows.get(slow.id)?.status).toBe("ready");
  });

  it("fails the media beyond the short wait line with PROCESSING_UNAVAILABLE (memory bound)", async () => {
    const { processor, repository, connect, media } = setup({
      mediaConcurrency: 1,
      maxWaitingMediaJobs: 1,
    });
    let release: () => void = () => undefined;

    media.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = await connect("audio");
    const waiting = await connect("audio");
    const refused = await connect("audio");

    for (const connection of [running, waiting, refused]) {
      processor.enqueue({ userId: USER_ID, connection, bytes: buildMp3(), clearFirst: false });
    }

    await waitFor(() => repository.rows.get(refused.id)?.status === "failed");

    expect(repository.rows.get(refused.id)?.errorCode).toBe("PROCESSING_UNAVAILABLE");

    release();
    await processor.idle();

    expect(repository.rows.get(running.id)?.status).toBe("ready");
    expect(repository.rows.get(waiting.id)?.status).toBe("ready");
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Condition not met in time.");
}
