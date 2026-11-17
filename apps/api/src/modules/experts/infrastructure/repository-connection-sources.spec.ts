import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryConnectionRepository } from "../../connections/testing";
import { ConnectionNotFoundError, ConnectionNotReadyError } from "../domain/expert-errors";
import { RepositoryConnectionSources } from "./repository-connection-sources";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

async function connect(
  repository: InMemoryConnectionRepository,
  userId: string,
  status: "ready" | "processing" | "failed",
) {
  const { connection } = await repository.insertProcessing(userId, {
    kind: "pdf",
    name: "plano.pdf",
    sizeBytes: 10,
    contentHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
  });

  if (status === "ready") {
    await repository.markReady(userId, connection.id, 3);
  } else if (status === "failed") {
    await repository.markFailed(userId, connection.id, "NO_EXTRACTABLE_TEXT");
  }

  return connection.id;
}

describe("RepositoryConnectionSources (R2)", () => {
  it("accepts ready connections of the user", async () => {
    const repository = new InMemoryConnectionRepository();
    const sources = new RepositoryConnectionSources(repository);
    const first = await connect(repository, ALICE, "ready");
    const second = await connect(repository, ALICE, "ready");

    await expect(sources.assertAttachable(ALICE, [first, second])).resolves.toBeUndefined();
  });

  it("answers not found for an unknown id and for an id of another user, alike", async () => {
    const repository = new InMemoryConnectionRepository();
    const sources = new RepositoryConnectionSources(repository);
    const bobs = await connect(repository, BOB, "ready");

    await expect(sources.assertAttachable(ALICE, [bobs])).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
    await expect(sources.assertAttachable(ALICE, [randomUUID()])).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
  });

  it("answers not ready for a connection that is processing or failed", async () => {
    const repository = new InMemoryConnectionRepository();
    const sources = new RepositoryConnectionSources(repository);

    for (const status of ["processing", "failed"] as const) {
      const id = await connect(repository, ALICE, status);

      await expect(sources.assertAttachable(ALICE, [id])).rejects.toBeInstanceOf(
        ConnectionNotReadyError,
      );
    }
  });

  it("answers not found before not ready when both happen", async () => {
    const repository = new InMemoryConnectionRepository();
    const sources = new RepositoryConnectionSources(repository);
    const processing = await connect(repository, ALICE, "processing");

    await expect(
      sources.assertAttachable(ALICE, [processing, randomUUID()]),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it("knows whether the user has a ready connection", async () => {
    const repository = new InMemoryConnectionRepository();
    const sources = new RepositoryConnectionSources(repository);

    await connect(repository, ALICE, "processing");
    await connect(repository, BOB, "ready");

    await expect(sources.hasReadyConnection(ALICE)).resolves.toBe(false);

    await connect(repository, ALICE, "ready");

    await expect(sources.hasReadyConnection(ALICE)).resolves.toBe(true);
  });
});
