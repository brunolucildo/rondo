import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConnectionNotFoundError } from "../../domain/connection-errors";
import { STALE_PROCESSING_MS } from "../../domain/connection-rules";
import { InMemoryConnectionRepository } from "../../testing/in-memory-connection.repository";
import { GetConnection } from "./get-connection.use-case";

const USER_ID = randomUUID();
const OTHER_USER_ID = randomUUID();

async function seeded(now: () => Date) {
  const repository = new InMemoryConnectionRepository(now);
  const { connection } = await repository.insertProcessing(USER_ID, {
    kind: "pdf",
    name: "plan.pdf",
    sizeBytes: 12,
    contentHash: "a".repeat(64),
  });

  return { repository, connection, get: new GetConnection(repository, now) };
}

describe("GetConnection", () => {
  it("returns the connection of the user", async () => {
    const { get, connection } = await seeded(() => new Date());

    await expect(
      get.execute({ userId: USER_ID, connectionId: connection.id }),
    ).resolves.toMatchObject({
      id: connection.id,
      status: "processing",
    });
  });

  it("answers not found for another user's connection and for an unknown id (R7)", async () => {
    const { get, connection } = await seeded(() => new Date());

    await expect(
      get.execute({ userId: OTHER_USER_ID, connectionId: connection.id }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
    await expect(
      get.execute({ userId: USER_ID, connectionId: randomUUID() }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it("turns a connection stuck in processing for over 15 minutes into failed (R6)", async () => {
    let clock = new Date("2026-11-17T10:00:00Z");
    const { get, connection } = await seeded(() => clock);

    clock = new Date(clock.getTime() + STALE_PROCESSING_MS + 1000);

    await expect(
      get.execute({ userId: USER_ID, connectionId: connection.id }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "PROCESSING_UNAVAILABLE",
    });
  });

  it("leaves a processing connection alone before the 15 minutes pass", async () => {
    let clock = new Date("2026-11-17T10:00:00Z");
    const { get, connection } = await seeded(() => clock);

    clock = new Date(clock.getTime() + STALE_PROCESSING_MS - 1000);

    await expect(
      get.execute({ userId: USER_ID, connectionId: connection.id }),
    ).resolves.toMatchObject({
      status: "processing",
    });
  });
});
