/** A piece of a connected document, ready to be indexed. */
export interface KnowledgeChunk {
  /** The connection (uploaded file, URL...) the chunk came from. */
  connectionId: string;
  /** Display name of the source, for citations. No path and no PII beyond the document's own name. */
  sourceName: string;
  /** Zero-based position of the chunk inside its connection; with `connectionId` it is the chunk's identity. */
  position: number;
  /** One-based page, when the source has pages. */
  page?: number;
  /** Second of the audio or video the chunk starts at (spec 0028), when the source has a timeline. */
  startSeconds?: number;
  text: string;
  /** Embedding of `text`, computed by the application (never by the index). */
  vector: readonly number[];
}

export interface KnowledgeSearchHit {
  connectionId: string;
  sourceName: string;
  position: number;
  page?: number;
  startSeconds?: number;
  text: string;
  /** Cosine similarity to the query, from -1 to 1 (higher is closer). */
  score: number;
}

export interface KnowledgeSearchOptions {
  /** 1 to `MAX_SEARCH_LIMIT`. */
  limit: number;
  /** Restricts the search to these connections; an empty list matches nothing. */
  connectionIds?: readonly string[];
}

/**
 * The per-user vector index of the experts' knowledge. Every operation takes the `userId` of the
 * session and touches only that user's data: isolation is a property of the adapter, not a filter
 * the caller must remember. Implementations throw `KnowledgeIndexUnavailableError` when the index
 * cannot answer and `KnowledgeInputError` when the arguments break the contract.
 */
export interface KnowledgeIndex {
  /** Writes the chunks, replacing the ones with the same connection and position. Idempotent. */
  upsert(userId: string, chunks: readonly KnowledgeChunk[]): Promise<void>;
  /** The closest chunks of this user, best first. A user without data gets `[]`. */
  search(
    userId: string,
    queryVector: readonly number[],
    options: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchHit[]>;
  /** Removes every chunk of one connection. Idempotent. */
  deleteByConnection(userId: string, connectionId: string): Promise<void>;
  /** Removes everything the user has in the index. Idempotent. */
  deleteAllForUser(userId: string): Promise<void>;
}
