import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryConnectionRepository } from "../../connections/testing";
import { RepositoryCitationSources } from "./repository-citation-sources";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

describe("RepositoryCitationSources (R7)", () => {
  it("answers only the cited connections that still exist for the user", async () => {
    const repository = new InMemoryConnectionRepository();
    const sources = new RepositoryCitationSources(repository);
    const mine = await repository.insertProcessing(ALICE, {
      kind: "txt",
      name: "mine.txt",
      sizeBytes: 1,
      contentHash: "a".repeat(64),
    });
    const theirs = await repository.insertProcessing(BOB, {
      kind: "txt",
      name: "theirs.txt",
      sizeBytes: 1,
      contentHash: "b".repeat(64),
    });
    const gone = randomUUID();

    await expect(
      sources.existingConnectionIds(ALICE, [mine.connection.id, theirs.connection.id, gone]),
    ).resolves.toEqual(new Set([mine.connection.id]));
    await expect(sources.existingConnectionIds(ALICE, [])).resolves.toEqual(new Set());
  });
});
