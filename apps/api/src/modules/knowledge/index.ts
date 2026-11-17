/** Public surface of the knowledge module: other modules import only from here. */
export type { EmbeddingsGenerator } from "./domain/embeddings-generator";
export {
  EmbeddingsUnavailableError,
  type EmbeddingsErrorCode,
  KnowledgeIndexUnavailableError,
  type KnowledgeIndexErrorCode,
  KnowledgeInputError,
} from "./domain/knowledge-errors";
export type {
  KnowledgeChunk,
  KnowledgeIndex,
  KnowledgeSearchHit,
  KnowledgeSearchOptions,
} from "./domain/knowledge-index";
export {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDINGS_BATCH_SIZE,
  MAX_SEARCH_LIMIT,
} from "./domain/knowledge-rules";
export { EMBEDDINGS_GENERATOR, KNOWLEDGE_INDEX } from "./knowledge.tokens";
export { KnowledgeModule } from "./knowledge.module";
