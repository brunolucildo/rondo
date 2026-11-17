/**
 * Test doubles of the knowledge ports, kept out of the public barrel like the e-mail capture
 * helpers: use cases of the next specs run on these without Weaviate or OpenAI.
 */
export { FakeEmbeddingsGenerator, fakeVectorOf } from "../infrastructure/fake-embeddings-generator";
export { InMemoryKnowledgeIndex } from "../infrastructure/in-memory-knowledge-index";
