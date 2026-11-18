import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidUploadError,
  MediaDailyLimitError,
  MediaUnavailableError,
  TooManyProcessingError,
} from "../../domain/connection-errors";
import type { ConnectionTelemetry } from "../../domain/connection-ports";
import {
  MAX_MEDIA_SECONDS_PER_DAY,
  STALE_MEDIA_PROCESSING_MS,
  STALE_PROCESSING_MS,
} from "../../domain/connection-rules";
import { NodeContentHasher } from "../../infrastructure/node-content-hasher";
import { InMemoryConnectionRepository } from "../../testing/in-memory-connection.repository";
import { buildMp3, buildMp4 } from "../../testing/media-fixtures";
import type { ConnectionProcessor, ProcessRequest } from "../services/connection-processor";
import { UploadConnection } from "./upload-connection.use-case";

const USER_ID = randomUUID();
const OTHER_USER_ID = randomUUID();

function setup(options: { available?: boolean; clock?: { now: Date } } = {}) {
  const clock = options.clock ?? { now: new Date("2026-11-18T12:00:00Z") };
  const now = () => clock.now;
  const repository = new InMemoryConnectionRepository(now);
  const enqueued: ProcessRequest[] = [];
  const processor = { enqueue: (request: ProcessRequest) => enqueued.push(request) };
  const telemetry: ConnectionTelemetry = {
    traceIngestion: vi.fn(),
    recordDeduplicated: vi.fn(),
    recordDeletion: vi.fn(),
  };
  const upload = new UploadConnection(
    repository,
    new NodeContentHasher(),
    processor as unknown as ConnectionProcessor,
    telemetry,
    now,
    () => options.available ?? true,
  );

  return { repository, enqueued, telemetry, upload, clock };
}

const send = (upload: UploadConnection, fileName: string, bytes: Buffer, userId = USER_ID) =>
  upload.execute({ userId, fileName, bytes });

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof InvalidUploadError) {
      return error.code;
    }

    return error instanceof Error ? error.name : "other";
  }

  return "none";
}

describe("UploadConnection with audio and video (spec 0028)", () => {
  it("creates a processing audio and a processing video with their kind and duration (R1)", async () => {
    const { upload, enqueued } = setup();
    const audio = await send(upload, "talk.mp3", buildMp3({ declaredFrames: 11484, frames: 2 }));
    const video = await send(upload, "match.MP4", buildMp4({ durationSeconds: 480 }));

    expect(audio.connection).toMatchObject({
      kind: "audio",
      status: "processing",
      durationSeconds: 300,
    });
    expect(video.connection).toMatchObject({
      kind: "video",
      name: "match.MP4",
      durationSeconds: 480,
    });
    expect(enqueued).toHaveLength(2);
  });

  it("refuses with MEDIA_UNAVAILABLE, writing nothing, when there is no provider key (R6)", async () => {
    const { upload, repository, enqueued } = setup({ available: false });

    expect(await codeOf(send(upload, "match.mp4", buildMp4()))).toBe(MediaUnavailableError.name);
    expect(repository.rows.size).toBe(0);
    expect(repository.mediaUsage).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("still serves documents when the provider is unavailable (R6)", async () => {
    const { upload } = setup({ available: false });
    const result = await send(upload, "notes.txt", Buffer.from("plain notes"));

    expect(result.connection.kind).toBe("txt");
  });

  it("deduplicates a media that is ready without checking the provider, the slots or the day (R2)", async () => {
    const { upload, repository, enqueued } = setup();
    const bytes = buildMp4({ salt: "same" });
    const first = await send(upload, "match.mp4", bytes);

    await repository.markReady(USER_ID, first.connection.id, 3);
    enqueued.length = 0;

    const unavailable = setup({ available: false });
    // Same repository content through another use case whose provider is off.
    unavailable.repository.rows.set(first.connection.id, {
      ...first.connection,
      status: "ready",
      chunkCount: 3,
    });

    const again = await send(upload, "copy.mp4", bytes);
    const whileOff = await send(unavailable.upload, "copy.mp4", bytes);

    expect(again).toMatchObject({ deduplicated: true, connection: { id: first.connection.id } });
    expect(whileOff.deduplicated).toBe(true);
    expect(enqueued).toEqual([]);
    // Only the first upload booked minutes.
    expect(repository.mediaUsage).toHaveLength(1);
  });

  it("processes the same media again for another user (R2)", async () => {
    const { upload, enqueued } = setup();
    const bytes = buildMp3({ salt: "shared" });

    await send(upload, "a.mp3", bytes);
    const other = await send(upload, "a.mp3", bytes, OTHER_USER_ID);

    expect(other.deduplicated).toBe(false);
    expect(enqueued).toHaveLength(2);
  });

  it("answers TOO_MANY_PROCESSING for a third media while two are processing, and frees the slot when one ends (R5)", async () => {
    const { upload, repository } = setup();
    const first = await send(upload, "a.mp4", buildMp4({ salt: "1" }));

    await send(upload, "b.mp3", buildMp3({ salt: "2" }));
    expect(await codeOf(send(upload, "c.mp4", buildMp4({ salt: "3" })))).toBe(
      TooManyProcessingError.name,
    );
    // A document is not media: it does not need a slot.
    await send(upload, "notes.md", Buffer.from("# fine"));
    // Another user has their own slots.
    await send(upload, "c.mp4", buildMp4({ salt: "3" }), OTHER_USER_ID);

    await repository.markReady(USER_ID, first.connection.id, 1);

    expect((await send(upload, "c.mp4", buildMp4({ salt: "3" }))).connection.status).toBe(
      "processing",
    );
  });

  it("ignores a media stuck in processing for more than 30 minutes when counting the slots (R5)", async () => {
    const { upload, clock } = setup();

    await send(upload, "a.mp4", buildMp4({ salt: "1" }));
    await send(upload, "b.mp4", buildMp4({ salt: "2" }));
    clock.now = new Date(clock.now.getTime() + STALE_MEDIA_PROCESSING_MS + 1000);

    expect((await send(upload, "c.mp4", buildMp4({ salt: "3" }))).connection.status).toBe(
      "processing",
    );
  });

  it("keeps a media processing past the 15 minutes a document gets, until 30 (R5)", async () => {
    const { upload, clock } = setup();
    const first = await send(upload, "a.mp4", buildMp4({ salt: "1" }));

    clock.now = new Date(clock.now.getTime() + STALE_PROCESSING_MS + 60_000);

    const again = await send(upload, "a.mp4", buildMp4({ salt: "1" }));

    expect(again).toMatchObject({
      deduplicated: true,
      connection: { id: first.connection.id, status: "processing" },
    });
  });

  it("answers MEDIA_DAILY_LIMIT before processing once the 100 minutes of a rolling day are used (R10)", async () => {
    const { upload, repository, clock, enqueued } = setup();

    await send(upload, "a.mp4", buildMp4({ durationSeconds: 20 * 60, salt: "1" }));
    await repository.markReady(USER_ID, [...repository.rows.keys()][0] as string, 1);

    for (const salt of ["2", "3", "4", "5"]) {
      const sent = await send(upload, `${salt}.mp4`, buildMp4({ durationSeconds: 20 * 60, salt }));

      await repository.markReady(USER_ID, sent.connection.id, 1);
    }

    enqueued.length = 0;
    expect(
      await codeOf(
        send(upload, "six.mp3", buildMp3({ declaredFrames: 3000, frames: 2, salt: "6" })),
      ),
    ).toBe(MediaDailyLimitError.name);
    expect(enqueued).toEqual([]);
    expect(repository.rows.size).toBe(5);

    // The limit is rolling: a day later the minutes are free again.
    clock.now = new Date(clock.now.getTime() + 24 * 60 * 60_000 + 1000);

    expect(
      (await send(upload, "six.mp3", buildMp3({ declaredFrames: 3000, frames: 2, salt: "6" })))
        .connection.status,
    ).toBe("processing");
  });

  it("does not give the minutes back when a media is deleted (R10)", async () => {
    const { upload, repository } = setup();

    await repository.reserveMediaSeconds(
      USER_ID,
      MAX_MEDIA_SECONDS_PER_DAY - 60,
      MAX_MEDIA_SECONDS_PER_DAY,
    );

    const sent = await send(upload, "a.mp4", buildMp4({ durationSeconds: 60, salt: "x" }));

    await repository.markReady(USER_ID, sent.connection.id, 1);
    await repository.deleteSettled(USER_ID, sent.connection.id, new Date(0));

    expect(
      await codeOf(send(upload, "again.mp4", buildMp4({ durationSeconds: 60, salt: "x" }))),
    ).toBe(MediaDailyLimitError.name);
  });

  it("retries a failed media, checking the slots and the day first (R5, R6)", async () => {
    const { upload, repository, enqueued } = setup();
    const bytes = buildMp4({ salt: "retry" });
    const first = await send(upload, "a.mp4", bytes);

    await repository.markFailed(USER_ID, first.connection.id, "PROCESSING_UNAVAILABLE");
    enqueued.length = 0;

    const retried = await send(upload, "a.mp4", bytes);

    expect(retried).toMatchObject({ deduplicated: false, connection: { status: "processing" } });
    expect(enqueued[0]).toMatchObject({ clearFirst: true });
  });

  it("refuses a media over the limits before anything else (R1)", async () => {
    const { upload, repository } = setup();

    expect(await codeOf(send(upload, "long.mp4", buildMp4({ durationSeconds: 21 * 60 })))).toBe(
      "MEDIA_TOO_LONG",
    );
    expect(await codeOf(send(upload, "fake.mp3", Buffer.from("RIFF....WAVEfmt ")))).toBe(
      "UNSUPPORTED_FILE",
    );
    expect(repository.rows.size).toBe(0);
  });
});
