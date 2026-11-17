import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeInputError } from "../../src/modules/knowledge/domain/knowledge-errors";
import type {
  KnowledgeChunk,
  KnowledgeIndex,
} from "../../src/modules/knowledge/domain/knowledge-index";
import { fakeVectorOf } from "../../src/modules/knowledge/infrastructure/fake-embeddings-generator";

/** A chunk whose vector is the fake embedding of its text (the same text, the same vector). */
export function chunkOf(
  connectionId: string,
  position: number,
  text: string,
  extra: Partial<Pick<KnowledgeChunk, "page" | "sourceName">> = {},
): KnowledgeChunk {
  return {
    connectionId,
    sourceName: extra.sourceName ?? "notes.txt",
    position,
    ...(extra.page === undefined ? {} : { page: extra.page }),
    text,
    vector: fakeVectorOf(text),
  };
}

/**
 * The behavior every `KnowledgeIndex` must have (spec `0022`, R3 to R5). Run against the in-memory
 * fake in the unit tests and against Weaviate in the integration tests, so the fake cannot drift.
 * Every test uses fresh random users and removes them afterwards.
 */
export function describeKnowledgeIndexContract(name: string, getIndex: () => KnowledgeIndex): void {
  describe(`${name} (KnowledgeIndex contract)`, () => {
    const users: string[] = [];

    const newUser = (): string => {
      const id = randomUUID();

      users.push(id);

      return id;
    };

    afterEach(async () => {
      const index = getIndex();

      await Promise.all(users.splice(0).map((userId) => index.deleteAllForUser(userId)));
    });

    it("never returns one user's chunks to another user, even for the same text (R4)", async () => {
      const index = getIndex();
      const [alice, bob] = [newUser(), newUser()];
      const [aliceConnection, bobConnection] = [randomUUID(), randomUUID()];
      const text = "Shared sentence about the training load of the week.";

      await index.upsert(alice, [chunkOf(aliceConnection, 0, text)]);
      await index.upsert(bob, [chunkOf(bobConnection, 0, text)]);

      const forBob = await index.search(bob, fakeVectorOf(text), { limit: 10 });
      const forAlice = await index.search(alice, fakeVectorOf(text), { limit: 10 });

      expect(forBob.map((hit) => hit.connectionId)).toEqual([bobConnection]);
      expect(forAlice.map((hit) => hit.connectionId)).toEqual([aliceConnection]);

      await index.deleteAllForUser(alice);

      expect(await index.search(alice, fakeVectorOf(text), { limit: 10 })).toEqual([]);
      expect(
        (await index.search(bob, fakeVectorOf(text), { limit: 10 })).map((hit) => hit.text),
      ).toEqual([text]);
    });

    it("returns the metadata of the best match first, with a score near 1 for the same text (R3)", async () => {
      const index = getIndex();
      const user = newUser();
      const connectionId = randomUUID();

      await index.upsert(user, [
        chunkOf(connectionId, 0, "first chunk", { page: 3, sourceName: "report.pdf" }),
        chunkOf(connectionId, 1, "second chunk"),
        chunkOf(connectionId, 2, "third chunk"),
      ]);

      const hits = await index.search(user, fakeVectorOf("first chunk"), { limit: 2 });

      expect(hits).toHaveLength(2);
      expect(hits[0]).toMatchObject({
        connectionId,
        sourceName: "report.pdf",
        position: 0,
        page: 3,
        text: "first chunk",
      });
      expect(hits[0]?.score).toBeGreaterThan(0.999);
      expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 1);

      const second = await index.search(user, fakeVectorOf("second chunk"), { limit: 1 });

      expect(second[0]?.page).toBeUndefined();
    });

    it("replaces a chunk written again with the same connection and position (idempotent upsert)", async () => {
      const index = getIndex();
      const user = newUser();
      const connectionId = randomUUID();

      await index.upsert(user, [chunkOf(connectionId, 0, "old text")]);
      await index.upsert(user, [chunkOf(connectionId, 0, "new text")]);
      await index.upsert(user, [chunkOf(connectionId, 0, "new text")]);

      const hits = await index.search(user, fakeVectorOf("new text"), { limit: 10 });

      expect(hits.map((hit) => hit.text)).toEqual(["new text"]);
    });

    it("restricts the search to the given connections and matches nothing for an empty list", async () => {
      const index = getIndex();
      const user = newUser();
      const [one, two] = [randomUUID(), randomUUID()];

      await index.upsert(user, [chunkOf(one, 0, "alpha"), chunkOf(two, 0, "beta")]);

      const only = await index.search(user, fakeVectorOf("alpha"), {
        limit: 10,
        connectionIds: [two],
      });

      expect(only.map((hit) => hit.connectionId)).toEqual([two]);
      expect(
        await index.search(user, fakeVectorOf("alpha"), { limit: 10, connectionIds: [] }),
      ).toEqual([]);
    });

    it("answers [] for a user that never wrote anything (R4)", async () => {
      expect(await getIndex().search(newUser(), fakeVectorOf("anything"), { limit: 5 })).toEqual(
        [],
      );
    });

    it("deletes one connection and leaves the others, and repeating it does nothing (R5)", async () => {
      const index = getIndex();
      const user = newUser();
      const [one, two, three] = [randomUUID(), randomUUID(), randomUUID()];

      await index.upsert(user, [
        chunkOf(one, 0, "one a"),
        chunkOf(one, 1, "one b"),
        chunkOf(two, 0, "two a"),
        chunkOf(three, 0, "three a"),
      ]);

      await index.deleteByConnection(user, two);
      await index.deleteByConnection(user, two);

      const left = await index.search(user, fakeVectorOf("one a"), { limit: 10 });

      expect(left.map((hit) => hit.connectionId).sort()).toEqual([one, one, three].sort());
    });

    it("deletes everything of a user, repeating it does nothing, and a user without data is a no-op (R5)", async () => {
      const index = getIndex();
      const user = newUser();

      await index.upsert(user, [chunkOf(randomUUID(), 0, "to be erased")]);
      await index.deleteAllForUser(user);
      await index.deleteAllForUser(user);
      await index.deleteByConnection(user, randomUUID());

      expect(await index.search(user, fakeVectorOf("to be erased"), { limit: 5 })).toEqual([]);
      await expect(index.deleteAllForUser(newUser())).resolves.toBeUndefined();
    });

    it("accepts an empty upsert without side effects", async () => {
      const index = getIndex();
      const user = newUser();

      await expect(index.upsert(user, [])).resolves.toBeUndefined();
      expect(await index.search(user, fakeVectorOf("x"), { limit: 5 })).toEqual([]);
    });

    it("refuses arguments that break the contract, naming only the field", async () => {
      const index = getIndex();
      const user = newUser();
      const connectionId = randomUUID();
      const good = chunkOf(connectionId, 0, "ok");

      await expect(index.upsert("not-a-uuid", [good])).rejects.toThrow(KnowledgeInputError);
      await expect(index.upsert(user, [{ ...good, vector: [1, 2, 3] }])).rejects.toThrow(
        KnowledgeInputError,
      );
      await expect(index.upsert(user, [{ ...good, position: -1 }])).rejects.toThrow(
        KnowledgeInputError,
      );
      await expect(index.upsert(user, [{ ...good, text: "" }])).rejects.toThrow(
        KnowledgeInputError,
      );
      await expect(index.search(user, [1, 2], { limit: 5 })).rejects.toThrow(KnowledgeInputError);
      await expect(index.search(user, good.vector, { limit: 0 })).rejects.toThrow(
        KnowledgeInputError,
      );
      await expect(index.search(user, good.vector, { limit: 101 })).rejects.toThrow(
        KnowledgeInputError,
      );
      await expect(
        index.search(user, good.vector, { limit: 5, connectionIds: ["nope"] }),
      ).rejects.toThrow(KnowledgeInputError);
      await expect(index.deleteByConnection(user, "nope")).rejects.toThrow(KnowledgeInputError);
      await expect(index.deleteAllForUser("nope")).rejects.toThrow(KnowledgeInputError);

      const failure = await index
        .upsert(user, [{ ...good, text: "secret-text-in-error", vector: [1] }])
        .catch((error: unknown) => error);

      expect(String((failure as Error).message)).not.toContain("secret-text-in-error");
    });
  });
}
