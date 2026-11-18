import { describe, expect, it } from "vitest";
import { buildMp3, buildMp4 } from "../testing/media-fixtures";
import { InvalidUploadError } from "./connection-errors";
import {
  hasMp3Signature,
  hasMp4Signature,
  readMp3DurationSeconds,
  readMp4DurationSeconds,
} from "./media-metadata";
import { assertUploadContent } from "./upload-validation";

/** Frames of 1152 samples at 44.1 kHz that make about `seconds`. */
const framesFor = (seconds: number) => Math.floor((seconds * 44100) / 1152);

describe("signatures (R1)", () => {
  it("accepts an ID3 tag or an MPEG frame as an MP3 and an ftyp box as an MP4", () => {
    expect(hasMp3Signature(buildMp3({ script: "[00:01] hi" }))).toBe(true);
    expect(hasMp3Signature(buildMp3({ noId3: true }))).toBe(true);
    expect(hasMp4Signature(buildMp4())).toBe(true);
  });

  it("refuses a WAV renamed to .mp3, text and an MP3 handed in as an MP4", () => {
    const wav = Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVEfmt ", "latin1");

    expect(hasMp3Signature(wav)).toBe(false);
    expect(hasMp3Signature(Buffer.from("plain text, not audio"))).toBe(false);
    expect(hasMp4Signature(buildMp3())).toBe(false);
    expect(hasMp4Signature(Buffer.alloc(4))).toBe(false);
    expect(hasMp3Signature(Buffer.alloc(1))).toBe(false);
  });
});

describe("readMp3DurationSeconds", () => {
  it("takes the length from the frame count of a Xing/Info header, whatever the file size", () => {
    expect(readMp3DurationSeconds(buildMp3({ declaredFrames: framesFor(300), frames: 3 }))).toBe(
      300,
    );
    expect(
      readMp3DurationSeconds(buildMp3({ declaredFrames: framesFor(90 * 60), frames: 3 })),
    ).toBe(90 * 60);
  });

  it("estimates a constant bitrate file from its size, ignoring the ID3v2 and ID3v1 tags", () => {
    const frames = 100;
    // 100 frames of 417 bytes at 128 kbps are 2.6 seconds, rounded up.
    const plain = buildMp3({ frames, noId3: true });
    const tagged = buildMp3({ frames, script: "[00:01] a tag that is not audio", id3v1: true });

    expect(readMp3DurationSeconds(plain)).toBe(Math.ceil((frames * 417 * 8) / 128_000));
    expect(readMp3DurationSeconds(tagged)).toBe(Math.ceil((frames * 417 * 8) / 128_000));
  });

  it("cannot tell the length of a variable bitrate file without a header", () => {
    expect(readMp3DurationSeconds(buildMp3({ frames: 20, variableBitrate: true }))).toBeNull();
  });

  it("cannot tell the length of bytes that are not MPEG audio, or of a header with no frames", () => {
    expect(
      readMp3DurationSeconds(Buffer.from("ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000")),
    ).toBeNull();
    expect(readMp3DurationSeconds(buildMp3({ declaredFrames: 0, frames: 2 }))).toBeNull();
    expect(readMp3DurationSeconds(Buffer.alloc(0))).toBeNull();
  });
});

describe("readMp4DurationSeconds", () => {
  it("reads mvhd of version 0 and 1, with the moov box before or after the media data", () => {
    expect(readMp4DurationSeconds(buildMp4({ durationSeconds: 125 }))).toBe(125);
    expect(readMp4DurationSeconds(buildMp4({ durationSeconds: 125, moovAtEnd: true }))).toBe(125);
    expect(readMp4DurationSeconds(buildMp4({ durationSeconds: 3000, version1: true }))).toBe(3000);
  });

  it("is null without a moov box, with a zero length or with a box cut short", () => {
    expect(readMp4DurationSeconds(buildMp4({ noMoov: true }))).toBeNull();
    expect(readMp4DurationSeconds(buildMp4({ durationSeconds: 0 }))).toBeNull();
    expect(readMp4DurationSeconds(buildMp4().subarray(0, 40))).toBeNull();
  });
});

describe("assertUploadContent for audio and video (R1)", () => {
  const code = (action: () => unknown) => {
    try {
      action();
    } catch (error) {
      return error instanceof InvalidUploadError ? error.code : "other";
    }

    return "none";
  };

  it("returns the duration of a valid MP3 and MP4", () => {
    expect(
      assertUploadContent("audio", buildMp3({ declaredFrames: framesFor(600), frames: 2 })),
    ).toEqual({ durationSeconds: 600 });
    expect(assertUploadContent("video", buildMp4({ durationSeconds: 480 }))).toEqual({
      durationSeconds: 480,
    });
    expect(assertUploadContent("txt", Buffer.from("text"))).toEqual({ durationSeconds: null });
  });

  it("refuses a WAV renamed to .mp3 as UNSUPPORTED_FILE and an empty file as EMPTY_FILE", () => {
    expect(code(() => assertUploadContent("audio", Buffer.from("RIFF....WAVEfmt ")))).toBe(
      "UNSUPPORTED_FILE",
    );
    expect(code(() => assertUploadContent("video", Buffer.from("not an mp4 at all")))).toBe(
      "UNSUPPORTED_FILE",
    );
    expect(code(() => assertUploadContent("audio", Buffer.alloc(0)))).toBe("EMPTY_FILE");
  });

  it("refuses an MP3 of 90 minutes and an MP4 of 21 minutes as MEDIA_TOO_LONG, and accepts the limits", () => {
    expect(
      code(() =>
        assertUploadContent("audio", buildMp3({ declaredFrames: framesFor(90 * 60), frames: 2 })),
      ),
    ).toBe("MEDIA_TOO_LONG");
    expect(code(() => assertUploadContent("video", buildMp4({ durationSeconds: 21 * 60 })))).toBe(
      "MEDIA_TOO_LONG",
    );
    expect(code(() => assertUploadContent("video", buildMp4({ durationSeconds: 20 * 60 })))).toBe(
      "none",
    );
    expect(
      code(() =>
        assertUploadContent("audio", buildMp3({ declaredFrames: framesFor(60 * 60), frames: 2 })),
      ),
    ).toBe("none");
  });

  it("refuses a length that cannot be determined as MEDIA_UNREADABLE", () => {
    expect(
      code(() => assertUploadContent("audio", buildMp3({ frames: 20, variableBitrate: true }))),
    ).toBe("MEDIA_UNREADABLE");
    expect(code(() => assertUploadContent("video", buildMp4({ noMoov: true })))).toBe(
      "MEDIA_UNREADABLE",
    );
  });

  it("applies the size limit of each kind: 50 MB for MP3, 200 MB for MP4, 20 MB for text", () => {
    const mb = 1024 * 1024;

    expect(code(() => assertUploadContent("audio", Buffer.alloc(50 * mb + 1)))).toBe(
      "FILE_TOO_LARGE",
    );
    expect(code(() => assertUploadContent("video", Buffer.alloc(200 * mb + 1)))).toBe(
      "FILE_TOO_LARGE",
    );
    expect(code(() => assertUploadContent("txt", Buffer.alloc(20 * mb + 1, 0x61)))).toBe(
      "FILE_TOO_LARGE",
    );
  });
});
