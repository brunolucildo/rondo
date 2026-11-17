/**
 * Turns text into embedding vectors of `EMBEDDING_DIMENSIONS` numbers. Implementations throw
 * `EmbeddingsUnavailableError` when the provider cannot answer, and never log the text.
 */
export interface EmbeddingsGenerator {
  /** One vector per text, in the same order. Splits into provider-sized batches internally. */
  embedDocuments(texts: readonly string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
