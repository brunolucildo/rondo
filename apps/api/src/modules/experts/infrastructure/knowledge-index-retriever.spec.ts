import { describe, expect, it, vi } from "vitest";
import {
  type EmbeddingsGenerator,
  EmbeddingsUnavailableError,
  type KnowledgeIndex,
  KnowledgeIndexUnavailableError,
} from "../../knowledge";
import { FakeEmbeddingsGenerator, InMemoryKnowledgeIndex } from "../../knowledge/testing";
import { ExpertKnowledgeUnavailableError } from "../domain/expert-errors";
import { KnowledgeIndexRetriever } from "./knowledge-index-retriever";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const FILE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FILE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONFIG = { maxChunks: 6, minScore: 0.3 };
const signal = () => new AbortController().signal;

const embeddings = new FakeEmbeddingsGenerator();

async function seed(
  index: KnowledgeIndex,
  userId: string,
  connectionId: string,
  texts: readonly string[],
  sourceName = "plano.pdf",
) {
  const vectors = await embeddings.embedDocuments(texts);

  await index.upsert(
    userId,
    texts.map((text, position) => ({
      connectionId,
      sourceName,
      position,
      page: position + 1,
      text,
      vector: vectors[position] ?? [],
    })),
  );
}

describe("KnowledgeIndexRetriever (R1, R2)", () => {
  it("returns the chunk the question matches and drops what is below the threshold", async () => {
    const index = new InMemoryKnowledgeIndex();

    await seed(index, ALICE, FILE_A, ["the training load of week three", "an unrelated recipe"]);

    const chunks = await new KnowledgeIndexRetriever(embeddings, index, CONFIG).retrieve(
      { userId: ALICE, question: "the training load of week three", connectionIds: null },
      signal(),
    );

    expect(chunks.map((chunk) => chunk.text)).toEqual(["the training load of week three"]);
    expect(chunks[0]?.score).toBeGreaterThan(0.99);
  });

  it("returns [] when no chunk passes the threshold (the gap)", async () => {
    const index = new InMemoryKnowledgeIndex();

    await seed(index, ALICE, FILE_A, ["one text", "another text"]);

    await expect(
      new KnowledgeIndexRetriever(embeddings, index, CONFIG).retrieve(
        { userId: ALICE, question: "something else entirely", connectionIds: null },
        signal(),
      ),
    ).resolves.toEqual([]);
  });

  it("limits the result to maxChunks, best first", async () => {
    const search = vi.fn().mockResolvedValue(
      [0.9, 0.8, 0.7, 0.6].map((score, position) => ({
        connectionId: FILE_A,
        sourceName: "a.pdf",
        position,
        text: `t${position}`,
        score,
      })),
    );
    const index = { search } as unknown as KnowledgeIndex;
    const chunks = await new KnowledgeIndexRetriever(embeddings, index, {
      maxChunks: 2,
      minScore: 0.3,
    }).retrieve({ userId: ALICE, question: "q", connectionIds: null }, signal());

    expect(chunks.map((chunk) => chunk.score)).toEqual([0.9, 0.8]);
    expect(search).toHaveBeenCalledWith(ALICE, expect.any(Array), { limit: 2 });
  });

  it("restricts the search to the attached connections and searches everything without them", async () => {
    const index = new InMemoryKnowledgeIndex();
    const text = "the same question text";

    await seed(index, ALICE, FILE_A, [text], "first.pdf");
    await seed(index, ALICE, FILE_B, [text], "second.pdf");

    const retriever = new KnowledgeIndexRetriever(embeddings, index, CONFIG);
    const scoped = await retriever.retrieve(
      { userId: ALICE, question: text, connectionIds: [FILE_A] },
      signal(),
    );
    const everything = await retriever.retrieve(
      { userId: ALICE, question: text, connectionIds: null },
      signal(),
    );

    expect(new Set(scoped.map((chunk) => chunk.connectionId))).toEqual(new Set([FILE_A]));
    expect(new Set(everything.map((chunk) => chunk.connectionId))).toEqual(
      new Set([FILE_A, FILE_B]),
    );
  });

  it("never reaches the chunks of another user", async () => {
    const index = new InMemoryKnowledgeIndex();

    await seed(index, ALICE, FILE_A, ["secret of alice"]);

    await expect(
      new KnowledgeIndexRetriever(embeddings, index, CONFIG).retrieve(
        { userId: BOB, question: "secret of alice", connectionIds: null },
        signal(),
      ),
    ).resolves.toEqual([]);
  });

  it("turns a failure of the embeddings into ExpertKnowledgeUnavailableError", async () => {
    const broken: EmbeddingsGenerator = {
      embedDocuments: () => Promise.resolve([]),
      embedQuery: () => Promise.reject(new EmbeddingsUnavailableError("TIMEOUT", true)),
    };

    await expect(
      new KnowledgeIndexRetriever(broken, new InMemoryKnowledgeIndex(), CONFIG).retrieve(
        { userId: ALICE, question: "q", connectionIds: null },
        signal(),
      ),
    ).rejects.toBeInstanceOf(ExpertKnowledgeUnavailableError);
  });

  it("turns a failure of the index into ExpertKnowledgeUnavailableError, hiding its message", async () => {
    const down = {
      search: () => Promise.reject(new KnowledgeIndexUnavailableError("CONNECTION", true)),
    } as unknown as KnowledgeIndex;
    const failure = new KnowledgeIndexRetriever(embeddings, down, CONFIG).retrieve(
      { userId: ALICE, question: "q", connectionIds: null },
      signal(),
    );

    await expect(failure).rejects.toBeInstanceOf(ExpertKnowledgeUnavailableError);
    await expect(failure).rejects.toMatchObject({
      message: "The knowledge base is unavailable right now.",
    });
  });

  it("does not search when the call was stopped while the question was embedded", async () => {
    const controller = new AbortController();
    const search = vi.fn();
    const stopping: EmbeddingsGenerator = {
      embedDocuments: () => Promise.resolve([]),
      embedQuery: (text) => {
        controller.abort();

        return embeddings.embedQuery(text);
      },
    };

    await expect(
      new KnowledgeIndexRetriever(
        stopping,
        { search } as unknown as KnowledgeIndex,
        CONFIG,
      ).retrieve({ userId: ALICE, question: "q", connectionIds: null }, controller.signal),
    ).rejects.not.toBeInstanceOf(ExpertKnowledgeUnavailableError);
    expect(search).not.toHaveBeenCalled();
  });
});
