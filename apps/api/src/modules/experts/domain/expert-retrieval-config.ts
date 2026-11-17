/** Chunks one question may bring to the model (the spec default). */
export const DEFAULT_RETRIEVAL_MAX_CHUNKS = 6;
/** The most the environment may ask for: each chunk costs prompt tokens. */
export const RETRIEVAL_MAX_CHUNKS_CEILING = 12;
/**
 * Cosine similarity below which a chunk is dropped. A first value, to be calibrated with the real
 * embeddings model (see `QA.md`): too high gives many "no source" answers, too low gives false
 * sources.
 */
export const DEFAULT_RETRIEVAL_MIN_SCORE = 0.3;

export interface ExpertRetrievalConfig {
  /** 1 to `RETRIEVAL_MAX_CHUNKS_CEILING`. */
  maxChunks: number;
  /** 0 to 1. */
  minScore: number;
}

/**
 * Reads the retrieval settings from the environment (`EXPERT_RETRIEVAL_MAX_CHUNKS` and
 * `EXPERT_RETRIEVAL_MIN_SCORE`). Both are optional; an invalid value fails the boot and the
 * message names the variable, never its value.
 */
export function parseExpertRetrievalConfig(
  env: Record<string, string | undefined>,
): ExpertRetrievalConfig {
  const rawMax = env.EXPERT_RETRIEVAL_MAX_CHUNKS?.trim();
  const rawScore = env.EXPERT_RETRIEVAL_MIN_SCORE?.trim();
  const maxChunks = rawMax ? Number(rawMax) : DEFAULT_RETRIEVAL_MAX_CHUNKS;
  const minScore = rawScore ? Number(rawScore) : DEFAULT_RETRIEVAL_MIN_SCORE;

  if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > RETRIEVAL_MAX_CHUNKS_CEILING) {
    throw new Error(
      `EXPERT_RETRIEVAL_MAX_CHUNKS must be an integer between 1 and ${RETRIEVAL_MAX_CHUNKS_CEILING}.`,
    );
  }

  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    throw new Error("EXPERT_RETRIEVAL_MIN_SCORE must be a number between 0 and 1.");
  }

  return { maxChunks, minScore };
}
