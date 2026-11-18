export type KnowledgeIndexErrorCode =
  | "CONNECTION"
  | "TIMEOUT"
  | "UNAUTHORIZED"
  | "SERVER_ERROR"
  | "REJECTED";

/**
 * The vector index could not do what was asked: it is down, slow, answered 5xx, refused the key or
 * rejected the request. The message is fixed on purpose: it never carries the client's error text,
 * which can repeat chunk text, vectors or the tenant name, so it is safe to log and to show.
 */
export class KnowledgeIndexUnavailableError extends Error {
  constructor(
    readonly code: KnowledgeIndexErrorCode,
    /** True when trying again can succeed (connection, timeout, 5xx). */
    readonly retryable: boolean,
    readonly attempts = 1,
  ) {
    super(`Knowledge index unavailable: ${code}`);
    this.name = "KnowledgeIndexUnavailableError";
  }

  withAttempts(attempts: number): KnowledgeIndexUnavailableError {
    return new KnowledgeIndexUnavailableError(this.code, this.retryable, attempts);
  }
}

export type EmbeddingsErrorCode = "NOT_CONFIGURED" | "TIMEOUT" | "RATE_LIMITED" | "PROVIDER_ERROR";

/** The embeddings provider could not produce the vectors. Fixed message, like the index error. */
export class EmbeddingsUnavailableError extends Error {
  constructor(
    readonly code: EmbeddingsErrorCode,
    readonly retryable: boolean,
    readonly attempts = 1,
  ) {
    super(`Embeddings unavailable: ${code}`);
    this.name = "EmbeddingsUnavailableError";
  }

  withAttempts(attempts: number): EmbeddingsUnavailableError {
    return new EmbeddingsUnavailableError(this.code, this.retryable, attempts);
  }
}

/** The caller passed something the index contract forbids (a bug in the caller, not an outage). */
export class KnowledgeInputError extends Error {
  constructor(readonly field: string) {
    super(`Invalid knowledge input: ${field}`);
    this.name = "KnowledgeInputError";
  }
}
