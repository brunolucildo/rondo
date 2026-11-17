import { describe, expect, it } from "vitest";
import {
  chunkOf,
  describeKnowledgeIndexContract,
} from "../../../../test/support/knowledge-index-contract";
import { EMBEDDING_DIMENSIONS } from "../domain/knowledge-rules";
import { fakeVectorOf, FakeEmbeddingsGenerator } from "./fake-embeddings-generator";
import { InMemoryKnowledgeIndex } from "./in-memory-knowledge-index";

const index = new InMemoryKnowledgeIndex();

describeKnowledgeIndexContract("InMemoryKnowledgeIndex", () => index);

describe("InMemoryKnowledgeIndex", () => {
  it("does not let a caller mutate what it stored", async () => {
    const userId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const connectionId = "1f8fad5b-d9cb-469f-a165-70867728950e";
    const chunk = chunkOf(connectionId, 0, "stored");
    const own = new InMemoryKnowledgeIndex();

    await own.upsert(userId, [chunk]);
    (chunk.vector as number[])[0] = 99;

    const [hit] = await own.search(userId, fakeVectorOf("stored"), { limit: 1 });

    expect(hit?.score).toBeGreaterThan(0.999);
  });
});

describe("FakeEmbeddingsGenerator", () => {
  it("is deterministic, unit-length and different for different texts", async () => {
    const generator = new FakeEmbeddingsGenerator();
    const [a1, b] = await generator.embedDocuments(["a", "b"]);
    const a2 = await generator.embedQuery("a");

    expect(a1).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
    expect(Math.hypot(...(a1 ?? []))).toBeCloseTo(1, 6);
  });
});
