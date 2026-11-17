import {
  failureReasonOf,
  type KnowledgeFailureReason,
  type KnowledgeIndexOperation,
  recordEmbeddingsCall,
  recordKnowledgeIndexCall,
  traceKnowledge,
} from "../../../observability/knowledge-telemetry";
import type { EmbeddingsGenerator } from "../domain/embeddings-generator";
import {
  EmbeddingsUnavailableError,
  KnowledgeIndexUnavailableError,
  KnowledgeInputError,
} from "../domain/knowledge-errors";
import type {
  KnowledgeChunk,
  KnowledgeIndex,
  KnowledgeSearchHit,
  KnowledgeSearchOptions,
} from "../domain/knowledge-index";

/** The closed `reason` of a failure: the typed error's code, `invalid_input` or `unknown`. */
function reasonOf(error: unknown): KnowledgeFailureReason {
  if (
    error instanceof KnowledgeIndexUnavailableError ||
    error instanceof EmbeddingsUnavailableError
  ) {
    return failureReasonOf(error.code);
  }

  return error instanceof KnowledgeInputError ? "invalid_input" : "unknown";
}

/**
 * Decorates a `KnowledgeIndex` with telemetry: one span (`knowledge.index.<operation>`), one
 * duration point and one log line per call. Nothing of the arguments or results is read.
 */
export class InstrumentedKnowledgeIndex implements KnowledgeIndex {
  /** `onClose` releases whatever the decorated index holds (the Weaviate connection). */
  constructor(
    private readonly inner: KnowledgeIndex,
    private readonly onClose: () => Promise<void> = () => Promise.resolve(),
  ) {}

  close(): Promise<void> {
    return this.onClose();
  }

  upsert(userId: string, chunks: readonly KnowledgeChunk[]): Promise<void> {
    return this.observe("upsert", () => this.inner.upsert(userId, chunks));
  }

  search(
    userId: string,
    queryVector: readonly number[],
    options: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchHit[]> {
    return this.observe("search", () => this.inner.search(userId, queryVector, options));
  }

  deleteByConnection(userId: string, connectionId: string): Promise<void> {
    return this.observe("delete_by_connection", () =>
      this.inner.deleteByConnection(userId, connectionId),
    );
  }

  deleteAllForUser(userId: string): Promise<void> {
    return this.observe("delete_all_for_user", () => this.inner.deleteAllForUser(userId));
  }

  private async observe<T>(operation: KnowledgeIndexOperation, run: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    let reason: KnowledgeFailureReason | "none" = "none";

    try {
      return await traceKnowledge(
        `knowledge.index.${operation}`,
        { "knowledge.operation": operation },
        run,
        reasonOf,
      );
    } catch (error) {
      reason = reasonOf(error);

      throw error;
    } finally {
      recordKnowledgeIndexCall({
        operation,
        outcome: reason === "none" ? "success" : "failure",
        reason,
        durationSeconds: (performance.now() - startedAt) / 1000,
      });
    }
  }
}

/** Decorates an `EmbeddingsGenerator` with a duration point, the text count and one log line per call. */
export class InstrumentedEmbeddingsGenerator implements EmbeddingsGenerator {
  constructor(private readonly inner: EmbeddingsGenerator) {}

  embedDocuments(texts: readonly string[]): Promise<number[][]> {
    return this.observe(texts.length, () => this.inner.embedDocuments(texts));
  }

  embedQuery(text: string): Promise<number[]> {
    return this.observe(1, () => this.inner.embedQuery(text));
  }

  private async observe<T>(texts: number, run: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    let reason: KnowledgeFailureReason | "none" = "none";

    try {
      return await run();
    } catch (error) {
      reason = reasonOf(error);

      throw error;
    } finally {
      recordEmbeddingsCall({
        outcome: reason === "none" ? "success" : "failure",
        reason,
        texts,
        durationSeconds: (performance.now() - startedAt) / 1000,
      });
    }
  }
}
