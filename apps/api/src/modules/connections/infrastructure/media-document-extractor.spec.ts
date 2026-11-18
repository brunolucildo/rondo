import { describe, expect, it } from "vitest";
import { ConnectionProcessingError } from "../domain/connection-errors";
import { MediaUnderstandingError, type MediaUnderstanding } from "../domain/media-understanding";
import { FakeMediaUnderstanding } from "./fake-media-understanding";
import { MediaDocumentExtractor } from "./media-document-extractor";
import { buildMp3, buildMp4 } from "../testing/media-fixtures";

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof ConnectionProcessingError ? error.code : "other";
  }

  return "none";
}

describe("MediaDocumentExtractor (R3, R6, R8)", () => {
  it("turns the timed transcript into sections that carry their start", async () => {
    const fake = new FakeMediaUnderstanding();
    const extractor = new MediaDocumentExtractor("audio", fake);
    const bytes = buildMp3({ script: "[00:05] Hello.\n[12:30] The exit from the back." });

    expect(await extractor.extract(bytes)).toEqual([
      { text: "Hello.", startSeconds: 5 },
      { text: "The exit from the back.", startSeconds: 750 },
    ]);
  });

  it("keeps the scene descriptions of a video next to the speech", async () => {
    const fake = new FakeMediaUnderstanding();
    const sections = await new MediaDocumentExtractor("video", fake).extract(
      buildMp4({ script: "[00:03] Speech.\n[00:10] SCENE: the scoreboard reads 2-1." }),
    );

    expect(sections.map((section) => section.text)).toEqual([
      "Speech.",
      "SCENE: the scoreboard reads 2-1.",
    ]);
  });

  it("sends the right type and the fixed instruction, with the ban on identifying people", async () => {
    const fake = new FakeMediaUnderstanding();

    await new MediaDocumentExtractor("video", fake).extract(buildMp4());

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ kind: "video", mimeType: "video/mp4" });
    expect(fake.calls[0]?.instruction).toContain("Never identify or name a person");
  });

  it.each([
    ["NO_CONTENT", "NO_EXTRACTABLE_TEXT"],
    ["UNREADABLE", "MEDIA_UNREADABLE"],
    ["REFUSED", "CONTENT_NOT_PROCESSABLE"],
    ["UNAVAILABLE", "PROCESSING_UNAVAILABLE"],
  ] as const)("maps a %s answer of the provider to %s", async (failure, code) => {
    const extractor = new MediaDocumentExtractor("audio", new FakeMediaUnderstanding());

    expect(await codeOf(extractor.extract(buildMp3({ fail: failure })))).toBe(code);
  });

  it("fails with NO_EXTRACTABLE_TEXT for an answer without any segment and PROCESSING_UNAVAILABLE for an unknown error", async () => {
    const empty: MediaUnderstanding = {
      isAvailable: () => true,
      understand: () => Promise.resolve("NO_CONTENT"),
    };
    const broken: MediaUnderstanding = {
      isAvailable: () => true,
      understand: () => Promise.reject(new Error("socket hang up")),
    };

    expect(await codeOf(new MediaDocumentExtractor("audio", empty).extract(buildMp3()))).toBe(
      "NO_EXTRACTABLE_TEXT",
    );
    expect(await codeOf(new MediaDocumentExtractor("audio", broken).extract(buildMp3()))).toBe(
      "PROCESSING_UNAVAILABLE",
    );
  });

  it("carries nothing of the provider's error into the one it throws", async () => {
    const leaky: MediaUnderstanding = {
      isAvailable: () => true,
      understand: () => Promise.reject(new MediaUnderstandingError("REFUSED")),
    };

    await expect(new MediaDocumentExtractor("audio", leaky).extract(buildMp3())).rejects.toThrow(
      "Connection processing failed: CONTENT_NOT_PROCESSABLE",
    );
  });
});
