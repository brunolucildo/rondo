import { createHash } from "node:crypto";
import type { EmbeddingsGenerator } from "../domain/embeddings-generator";
import { EMBEDDING_DIMENSIONS } from "../domain/knowledge-rules";

/** Small seeded PRNG (mulberry32): the same seed always yields the same sequence. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;

    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A unit vector of `EMBEDDING_DIMENSIONS` numbers derived only from `text`. */
export function fakeVectorOf(text: string): number[] {
  const seed = createHash("sha256").update(text).digest().readUInt32LE(0);
  const random = mulberry32(seed);
  const raw = Array.from({ length: EMBEDDING_DIMENSIONS }, () => random() * 2 - 1);
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));

  return raw.map((value) => value / norm);
}

/**
 * Offline `EmbeddingsGenerator`: deterministic vectors, no network, no key. The same text always
 * maps to the same vector and different texts map to nearly orthogonal ones, so a search for a
 * chunk's own text finds that chunk first. Used by the tests and, with `NODE_ENV=test`, by the
 * E2E API. It carries no meaning: never use it where relevance matters.
 */
export class FakeEmbeddingsGenerator implements EmbeddingsGenerator {
  embedDocuments(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(fakeVectorOf));
  }

  embedQuery(text: string): Promise<number[]> {
    return Promise.resolve(fakeVectorOf(text));
  }
}
