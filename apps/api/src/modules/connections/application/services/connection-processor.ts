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
  MAX_CHUNKS_PER_CONNECTION,
  PROCESSING_CONCURRENCY,
} from "../../domain/connection-rules";

/** Jobs waiting for a slot: each holds its file in memory, so the wait line is short on purpose. */
const MAX_WAITING_JOBS = 20;

export interface ConnectionProcessorDependencies {
  repository: ConnectionRepository;
  extractors: Readonly<Record<ConnectionKind, DocumentExtractor>>;
  chunker: TextChunker;
  embeddings: EmbeddingsGenerator;
  index: KnowledgeIndex;
  telemetry: ConnectionTelemetry;
  extractionTimeoutMs?: number;
  concurrency?: number;
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
  private readonly waiting: ProcessRequest[] = [];
  private readonly running = new Set<Promise<void>>();
  private readonly extractionTimeoutMs: number | undefined;
  private readonly concurrency: number;

  constructor(private readonly deps: ConnectionProcessorDependencies) {
    this.extractionTimeoutMs = deps.extractionTimeoutMs;
    this.concurrency = deps.concurrency ?? PROCESSING_CONCURRENCY;
  }

  /** Schedules the job. Never throws and never waits for it. */
  enqueue(request: ProcessRequest): void {
    if (this.waiting.length >= MAX_WAITING_JOBS) {
      void this.deps.repository
        .markFailed(request.userId, request.connection.id, "PROCESSING_UNAVAILABLE")
        .catch(() => undefined);

      return;
    }

    this.waiting.push(request);
    this.pump();
  }

  /** Resolves when every job started so far has ended (for tests and for shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0 || this.waiting.length > 0) {
      await Promise.allSettled(this.running);
    }
  }

  private pump(): void {
    while (this.running.size < this.concurrency) {
      const next = this.waiting.shift();

      if (next === undefined) {
        return;
      }

      const job: Promise<void> = this.run(next)
        .catch(() => undefined)
        .finally(() => {
          this.running.delete(job);
          this.pump();
        });

      this.running.add(job);
    }
  }

  private async run(request: ProcessRequest): Promise<void> {
    const { userId, connection } = request;

    await this.deps.telemetry.traceIngestion(
      connection.kind,
      async (): Promise<IngestionResult> => {
        try {
          const chunkCount = await this.ingest(request);

          await this.deps.repository.markReady(userId, connection.id, chunkCount);

          return { outcome: "success", reason: "none", deduplicated: false, chunkCount };
        } catch (error) {
          const code = errorCodeOf(error);

          await this.deps.index.deleteByConnection(userId, connection.id).catch(() => undefined);
          await this.deps.repository.markFailed(userId, connection.id, code).catch(() => undefined);

          return {
            outcome: "failure",
            reason: code.toLowerCase() as Lowercase<ConnectionErrorCode>,
            deduplicated: false,
            chunkCount: 0,
          };
        }
      },
    );
  }

  private async ingest({ userId, connection, bytes, clearFirst }: ProcessRequest): Promise<number> {
    const { extractors, chunker, embeddings, index } = this.deps;
    const sections = await withTimeout(
      extractors[connection.kind].extract(bytes),
      this.extractionTimeoutMs ??
        (connection.kind === "image" ? IMAGE_EXTRACTION_TIMEOUT_MS : EXTRACTION_TIMEOUT_MS),
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
        text: chunk.text,
        vector: vectors[position] ?? [],
      })),
    );

    return chunks.length;
  }
}
