import { KnowledgeInputError } from "./knowledge-errors";
import type { KnowledgeChunk, KnowledgeSearchOptions } from "./knowledge-index";
import { EMBEDDING_DIMENSIONS, isUuid, MAX_SEARCH_LIMIT } from "./knowledge-rules";

/**
 * Contract checks shared by every `KnowledgeIndex` implementation. They throw
 * `KnowledgeInputError` naming only the field, never the value (a value can be chunk text, a
 * vector or an id).
 */

export function assertUserId(userId: unknown): asserts userId is string {
  if (!isUuid(userId)) {
    throw new KnowledgeInputError("userId");
  }
}

export function assertConnectionId(connectionId: unknown): asserts connectionId is string {
  if (!isUuid(connectionId)) {
    throw new KnowledgeInputError("connectionId");
  }
}

export function assertVector(vector: readonly number[], field: string): void {
  if (
    !Array.isArray(vector) ||
    vector.length !== EMBEDDING_DIMENSIONS ||
    !vector.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    throw new KnowledgeInputError(field);
  }
}

export function assertChunks(chunks: readonly KnowledgeChunk[]): void {
  for (const chunk of chunks) {
    assertConnectionId(chunk.connectionId);

    if (typeof chunk.sourceName !== "string" || chunk.sourceName.length === 0) {
      throw new KnowledgeInputError("sourceName");
    }

    if (!Number.isInteger(chunk.position) || chunk.position < 0) {
      throw new KnowledgeInputError("position");
    }

    if (chunk.page !== undefined && (!Number.isInteger(chunk.page) || chunk.page < 1)) {
      throw new KnowledgeInputError("page");
    }

    if (
      chunk.startSeconds !== undefined &&
      (!Number.isInteger(chunk.startSeconds) || chunk.startSeconds < 0)
    ) {
      throw new KnowledgeInputError("startSeconds");
    }

    if (typeof chunk.text !== "string" || chunk.text.length === 0) {
      throw new KnowledgeInputError("text");
    }

    assertVector(chunk.vector, "vector");
  }
}

export function assertSearch(
  queryVector: readonly number[],
  options: KnowledgeSearchOptions,
): void {
  assertVector(queryVector, "queryVector");

  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_SEARCH_LIMIT) {
    throw new KnowledgeInputError("limit");
  }

  for (const connectionId of options.connectionIds ?? []) {
    assertConnectionId(connectionId);
  }
}
