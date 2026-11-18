import type { EmbeddingsGenerator, KnowledgeIndex } from "../../../knowledge";
import type { Connection, ConnectionErrorCode, ConnectionKind } from "../../domain/connection";
import { ConnectionProcessingError } from "../../domain/connection-errors";
import type {
  ConnectionRepository,
  ConnectionTelemetry,
  DocumentExtractor,
  IngestionResult,
  TextChunker,
} from "../../domain/connection-ports";
import {
  EXTRACTION_TIMEOUT_MS,
  IMAGE_EXTRACTION_TIMEOUT_MS,
  isMediaKind,
  MAX_CHUNKS_PER_CONNECTION,
  MAX_WAITING_MEDIA_JOBS,
  MEDIA_CONCURRENCY,
  MEDIA_EXTRACTION_TIMEOUT_MS,
  PROCESSING_CONCURRENCY,
} from "../../domain/connection-rules";

/** Jobs waiting for a slot: each holds its file in memory, so the wait line is short on purpose. */
const MAX_WAITING_JOBS = 20;

/**
 * Documents and media have their own lanes: a media waits minutes for the provider (little CPU) and
 * must not hold the slots a PDF needs, and a media holds up to 200 MB, so its lane is narrow.
 */
interface Lane {
  waiting: ProcessRequest[];
  running: Set<Promise<void>>;
  concurrency: number;
  maxWaiting: number;
}

export interface ConnectionProcessorDependencies {
  repository: ConnectionRepository;
  extractors: Readonly<Record<ConnectionKind, DocumentExtractor>>;
  chunker: TextChunker;
  embeddings: EmbeddingsGenerator;
  index: KnowledgeIndex;
  telemetry: ConnectionTelemetry;
  /** Chunker of audio and video: it keeps the start of each chunk (spec 0028). Defaults to `chunker`. */
  mediaChunker?: TextChunker;
  extractionTimeoutMs?: number;
  mediaExtractionTimeoutMs?: number;
  concurrency?: number;
  mediaConcurrency?: number;
  maxWaitingMediaJobs?: number;
}

export interface ProcessRequest {
  userId: string;
  /** The row, already `processing`. */
  connection: Connection;
  /** The file. Held in memory until the job ends; never written anywhere but the extractor's temp directory. */
  bytes: Uint8Array;
  /** Remove the vectors of this connection first (a retry after a failure may have left some). */
  clearFirst: boolean;
}

class ExtractionTimeoutError extends Error {
  constructor() {
    super("Extraction timed out.");
    this.name = "ExtractionTimeoutError";
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExtractionTimeoutError()), ms);
  });

  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function errorCodeOf(error: unknown): ConnectionErrorCode {
  return error instanceof ConnectionProcessingError ? error.code : "PROCESSING_UNAVAILABLE";
}

/**
 * Turns a `processing` connection into a `ready` one (R5) or a `failed` one with a closed code (R6).
 * Runs in the background, outside the request that created the connection: `enqueue` returns at
 * once. Up to `concurrency` jobs run at the same time and a few more wait; beyond that the new
 * connection fails with `PROCESSING_UNAVAILABLE` and the user can send the file again.
 *
 * The steps are extract, chunk (at most 2,000 chunks), embed and write to the index. On any
 * failure the vectors already written for the connection are removed, so a failed connection never
 * leaves partial chunks behind. Nothing here logs or puts content in an error.
 */
export class ConnectionProcessor {
  private readonly lanes: { document: Lane; media: Lane };
  private readonly extractionTimeoutMs: number | undefined;
  private readonly mediaExtractionTimeoutMs: number;

  constructor(private readonly deps: ConnectionProcessorDependencies) {
    this.extractionTimeoutMs = deps.extractionTimeoutMs;
    this.mediaExtractionTimeoutMs = deps.mediaExtractionTimeoutMs ?? MEDIA_EXTRACTION_TIMEOUT_MS;
    this.lanes = {
      document: {
        waiting: [],
        running: new Set(),
        concurrency: deps.concurrency ?? PROCESSING_CONCURRENCY,
        maxWaiting: MAX_WAITING_JOBS,
      },
      media: {
        waiting: [],
        running: new Set(),
        concurrency: deps.mediaConcurrency ?? MEDIA_CONCURRENCY,
        maxWaiting: deps.maxWaitingMediaJobs ?? MAX_WAITING_MEDIA_JOBS,
      },
    };
  }

  private laneOf(kind: ConnectionKind): Lane {
    return isMediaKind(kind) ? this.lanes.media : this.lanes.document;
  }

  /** Schedules the job. Never throws and never waits for it. */
  enqueue(request: ProcessRequest): void {
    const lane = this.laneOf(request.connection.kind);

    if (lane.waiting.length >= lane.maxWaiting) {
      void this.deps.repository
        .markFailed(request.userId, request.connection.id, "PROCESSING_UNAVAILABLE")
        .catch(() => undefined);

      return;
    }

    lane.waiting.push(request);
    this.pump(lane);
  }

  /** Resolves when every job started so far has ended (for tests and for shutdown). */
  async idle(): Promise<void> {
    const lanes = Object.values(this.lanes);

    while (lanes.some((lane) => lane.running.size > 0 || lane.waiting.length > 0)) {
      await Promise.allSettled(lanes.flatMap((lane) => [...lane.running]));
    }
  }

  private pump(lane: Lane): void {
    while (lane.running.size < lane.concurrency) {
      const next = lane.waiting.shift();

      if (next === undefined) {
        return;
      }

      const job: Promise<void> = this.run(next)
        .catch(() => undefined)
        .finally(() => {
          lane.running.delete(job);
          this.pump(lane);
        });

      lane.running.add(job);
    }
  }

  private async run(request: ProcessRequest): Promise<void> {
    const { userId, connection } = request;
    const mediaSeconds =
      isMediaKind(connection.kind) && connection.durationSeconds != null
        ? { mediaSeconds: connection.durationSeconds }
        : {};

    await this.deps.telemetry.traceIngestion(
      connection.kind,
      async (): Promise<IngestionResult> => {
        try {
          const chunkCount = await this.ingest(request);

          await this.deps.repository.markReady(userId, connection.id, chunkCount);

          return {
            outcome: "success",
            reason: "none",
            deduplicated: false,
            chunkCount,
            ...mediaSeconds,
          };
        } catch (error) {
          const code = errorCodeOf(error);

          await this.deps.index.deleteByConnection(userId, connection.id).catch(() => undefined);
          await this.deps.repository.markFailed(userId, connection.id, code).catch(() => undefined);

          return {
            outcome: "failure",
            reason: code.toLowerCase() as Lowercase<ConnectionErrorCode>,
            deduplicated: false,
            chunkCount: 0,
            ...mediaSeconds,
          };
        }
      },
    );
  }

  private async ingest({ userId, connection, bytes, clearFirst }: ProcessRequest): Promise<number> {
    const { extractors, embeddings, index } = this.deps;
    const media = isMediaKind(connection.kind);
    const chunker = media ? (this.deps.mediaChunker ?? this.deps.chunker) : this.deps.chunker;
    const sections = await withTimeout(
      extractors[connection.kind].extract(bytes),
      media
        ? this.mediaExtractionTimeoutMs
        : (this.extractionTimeoutMs ??
            (connection.kind === "image" ? IMAGE_EXTRACTION_TIMEOUT_MS : EXTRACTION_TIMEOUT_MS)),
    );
    const chunks = await chunker.chunk(sections);

    if (chunks.length === 0) {
      throw new ConnectionProcessingError("NO_EXTRACTABLE_TEXT");
    }

    if (chunks.length > MAX_CHUNKS_PER_CONNECTION) {
      throw new ConnectionProcessingError("TOO_MANY_CHUNKS");
    }

    const vectors = await embeddings.embedDocuments(chunks.map((chunk) => chunk.text));

    if (vectors.length !== chunks.length) {
      throw new ConnectionProcessingError("PROCESSING_UNAVAILABLE");
    }

    if (clearFirst) {
      await index.deleteByConnection(userId, connection.id);
    }

    await index.upsert(
      userId,
      chunks.map((chunk, position) => ({
        connectionId: connection.id,
        sourceName: connection.name,
        position,
        ...(chunk.page === undefined ? {} : { page: chunk.page }),
        ...(chunk.startSeconds === undefined ? {} : { startSeconds: chunk.startSeconds }),
        text: chunk.text,
        vector: vectors[position] ?? [],
      })),
    );

    return chunks.length;
  }
}
