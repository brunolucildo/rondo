import type {
  KnowledgeChunk,
  KnowledgeIndex,
  KnowledgeSearchHit,
  KnowledgeSearchOptions,
} from "../domain/knowledge-index";
import {
  assertChunks,
  assertConnectionId,
  assertSearch,
  assertUserId,
} from "../domain/knowledge-validation";

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;

    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * `KnowledgeIndex` in memory, with the same contract as the Weaviate adapter (per-user isolation,
 * idempotent upsert and deletes, `[]` for an unknown user). It lets the use cases of the next
 * specs run without Weaviate. Not for production: nothing survives the process.
 */
export class InMemoryKnowledgeIndex implements KnowledgeIndex {
  private readonly users = new Map<string, Map<string, KnowledgeChunk>>();

  // `async` so a contract violation rejects instead of throwing synchronously, like the real adapter.
  async upsert(userId: string, chunks: readonly KnowledgeChunk[]): Promise<void> {
    assertUserId(userId);
    assertChunks(chunks);

    if (chunks.length > 0) {
      const own = this.users.get(userId.toLowerCase()) ?? new Map<string, KnowledgeChunk>();

      for (const chunk of chunks) {
        own.set(`${chunk.connectionId}:${chunk.position}`, { ...chunk, vector: [...chunk.vector] });
      }

      this.users.set(userId.toLowerCase(), own);
    }
  }

  async search(
    userId: string,
    queryVector: readonly number[],
    options: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchHit[]> {
    assertUserId(userId);
    assertSearch(queryVector, options);

    const allowed =
      options.connectionIds === undefined ? undefined : new Set(options.connectionIds);
    const hits = [...(this.users.get(userId.toLowerCase())?.values() ?? [])]
      .filter((chunk) => allowed === undefined || allowed.has(chunk.connectionId))
      .map((chunk) => ({ chunk, score: cosine(queryVector, chunk.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit)
      .map(({ chunk, score }) => ({
        connectionId: chunk.connectionId,
        sourceName: chunk.sourceName,
        position: chunk.position,
        ...(chunk.page === undefined ? {} : { page: chunk.page }),
        text: chunk.text,
        score,
      }));

    return hits;
  }

  async deleteByConnection(userId: string, connectionId: string): Promise<void> {
    assertUserId(userId);
    assertConnectionId(connectionId);

    const own = this.users.get(userId.toLowerCase());

    for (const key of own?.keys() ?? []) {
      if (key.startsWith(`${connectionId}:`)) {
        own?.delete(key);
      }
    }
  }

  async deleteAllForUser(userId: string): Promise<void> {
    assertUserId(userId);
    this.users.delete(userId.toLowerCase());
  }
}
