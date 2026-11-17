import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConnectionLimitReachedError, InvalidUploadError } from "../../domain/connection-errors";
import type { ConnectionTelemetry } from "../../domain/connection-ports";
import { MAX_CONNECTIONS_PER_USER, STALE_PROCESSING_MS } from "../../domain/connection-rules";
import { NodeContentHasher } from "../../infrastructure/node-content-hasher";
import { InMemoryConnectionRepository } from "../../testing/in-memory-connection.repository";
import type { ConnectionProcessor, ProcessRequest } from "../services/connection-processor";
import { UploadConnection } from "./upload-connection.use-case";

const USER_ID = randomUUID();
const OTHER_USER_ID = randomUUID();
const hasher = new NodeContentHasher();

function setup(now: () => Date = () => new Date()) {
  const repository = new InMemoryConnectionRepository(now);
  const enqueued: ProcessRequest[] = [];
  const processor = { enqueue: (request: ProcessRequest) => enqueued.push(request) };
  const telemetry: ConnectionTelemetry = {
    traceIngestion: vi.fn(),
    recordDeduplicated: vi.fn(),
  };
  const upload = new UploadConnection(
    repository,
    hasher,
    processor as unknown as ConnectionProcessor,
    telemetry,
    now,
  );

  return { repository, enqueued, telemetry, upload };
}

const text = (content: string) => Buffer.from(content, "utf8");

describe("UploadConnection", () => {
  it("creates a processing connection and schedules its processing (R3, R5)", async () => {
    const { upload, enqueued, repository } = setup();
    const result = await upload.execute({
      userId: USER_ID,
      fileName: "notes.txt",
      bytes: text("hello"),
    });

    expect(result.deduplicated).toBe(false);
    expect(result.connection).toMatchObject({
      kind: "txt",
      name: "notes.txt",
      sizeBytes: 5,
      status: "processing",
    });
    expect(result.connection.contentHash).toBe(hasher.sha256(text("hello")));
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ userId: USER_ID, clearFirst: false });
    expect(repository.rows.size).toBe(1);
  });

  it("reuses a ready connection without processing again, whatever the file name (R3)", async () => {
    const { upload, enqueued, repository, telemetry } = setup();
    const first = await upload.execute({
      userId: USER_ID,
      fileName: "a.md",
      bytes: text("# same"),
    });

    await repository.markReady(USER_ID, first.connection.id, 3);
    enqueued.length = 0;

    const second = await upload.execute({
      userId: USER_ID,
      fileName: "renamed.md",
      bytes: text("# same"),
    });

    expect(second.deduplicated).toBe(true);
    expect(second.connection).toMatchObject({
      id: first.connection.id,
      status: "ready",
      name: "a.md",
    });
    expect(enqueued).toEqual([]);
    expect(telemetry.recordDeduplicated).toHaveBeenCalledWith("md", expect.any(Number));
  });

  it("returns the connection that is still processing instead of starting another", async () => {
    const { upload, enqueued } = setup();
    const first = await upload.execute({ userId: USER_ID, fileName: "a.txt", bytes: text("x1") });
    const second = await upload.execute({ userId: USER_ID, fileName: "a.txt", bytes: text("x1") });

    expect(second).toMatchObject({ deduplicated: true });
    expect(second.connection.id).toBe(first.connection.id);
    expect(enqueued).toHaveLength(1);
  });

  it("processes the same content again for another user (separate bases)", async () => {
    const { upload, enqueued } = setup();
    const mine = await upload.execute({ userId: USER_ID, fileName: "a.txt", bytes: text("same") });
    const theirs = await upload.execute({
      userId: OTHER_USER_ID,
      fileName: "a.txt",
      bytes: text("same"),
    });

    expect(theirs.deduplicated).toBe(false);
    expect(theirs.connection.id).not.toBe(mine.connection.id);
    expect(enqueued).toHaveLength(2);
  });

  it("reprocesses a failed connection, clearing leftovers first (R3, R6)", async () => {
    const { upload, enqueued, repository } = setup();
    const first = await upload.execute({
      userId: USER_ID,
      fileName: "a.txt",
      bytes: text("again"),
    });

    await repository.markFailed(USER_ID, first.connection.id, "NO_EXTRACTABLE_TEXT");
    enqueued.length = 0;

    const second = await upload.execute({
      userId: USER_ID,
      fileName: "a.txt",
      bytes: text("again"),
    });

    expect(second.deduplicated).toBe(false);
    expect(second.connection).toMatchObject({
      id: first.connection.id,
      status: "processing",
      errorCode: null,
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ clearFirst: true });
  });

  it("treats a connection stuck in processing for over 15 minutes as failed and reprocesses it (R6)", async () => {
    let clock = new Date("2026-11-17T10:00:00Z");
    const { upload, enqueued } = setup(() => clock);
    const first = await upload.execute({
      userId: USER_ID,
      fileName: "a.txt",
      bytes: text("stuck"),
    });

    enqueued.length = 0;
    clock = new Date(clock.getTime() + STALE_PROCESSING_MS + 1000);

    const second = await upload.execute({
      userId: USER_ID,
      fileName: "a.txt",
      bytes: text("stuck"),
    });

    expect(second.connection.id).toBe(first.connection.id);
    expect(second.deduplicated).toBe(false);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ clearFirst: true });
  });

  it("refuses the 51st connection but never a duplicate (R2)", async () => {
    const { upload, repository } = setup();

    for (let index = 0; index < MAX_CONNECTIONS_PER_USER; index += 1) {
      await upload.execute({
        userId: USER_ID,
        fileName: `f${index}.txt`,
        bytes: text(`file ${index}`),
      });
    }

    await expect(
      upload.execute({ userId: USER_ID, fileName: "one-more.txt", bytes: text("new content") }),
    ).rejects.toBeInstanceOf(ConnectionLimitReachedError);

    const again = await upload.execute({
      userId: USER_ID,
      fileName: "f0.txt",
      bytes: text("file 0"),
    });

    expect(again.deduplicated).toBe(true);
    expect(await repository.countByUser(USER_ID)).toBe(MAX_CONNECTIONS_PER_USER);
  });

  it.each([
    ["virus.exe", text("MZ")],
    ["fake.pdf", text("MZ not a pdf")],
    ["empty.txt", Buffer.alloc(0)],
  ])("rejects %s before touching the database", async (fileName, bytes) => {
    const { upload, repository } = setup();

    await expect(upload.execute({ userId: USER_ID, fileName, bytes })).rejects.toBeInstanceOf(
      InvalidUploadError,
    );
    expect(repository.rows.size).toBe(0);
  });

  it("resolves two simultaneous uploads of the same content into one connection and one processing (R4)", async () => {
    const { upload, enqueued, repository } = setup();
    const [a, b] = await Promise.all([
      upload.execute({ userId: USER_ID, fileName: "a.txt", bytes: text("race") }),
      upload.execute({ userId: USER_ID, fileName: "b.txt", bytes: text("race") }),
    ]);

    expect(a.connection.id).toBe(b.connection.id);
    expect(repository.rows.size).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect([a.deduplicated, b.deduplicated].sort()).toEqual([false, true]);
  });
});
