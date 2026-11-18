import { describe, expect, it } from "vitest";
import { buildMediaInstruction, parseTimedTranscript } from "./timed-transcript";

describe("parseTimedTranscript (R3)", () => {
  it("reads one segment per timed line, with the second each starts at", () => {
    expect(
      parseTimedTranscript(
        "[00:05] Hello team.\n[12:30] The exit from the back starts here.\n[1:02:03] Late.",
      ),
    ).toEqual([
      { startSeconds: 5, text: "Hello team." },
      { startSeconds: 750, text: "The exit from the back starts here." },
      { startSeconds: 3723, text: "Late." },
    ]);
  });

  it("accepts minutes above 59, ranges and SCENE lines", () => {
    expect(
      parseTimedTranscript("[75:10] Past the hour.\n[00:03 - 00:09] SCENE: a corner kick."),
    ).toEqual([
      { startSeconds: 4510, text: "Past the hour." },
      { startSeconds: 3, text: "SCENE: a corner kick." },
    ]);
  });

  it("continues a segment with a line that has no mark and opens one at zero before any mark", () => {
    expect(parseTimedTranscript("Before any mark.\n[00:10] One\nand a second line")).toEqual([
      { startSeconds: 0, text: "Before any mark." },
      { startSeconds: 10, text: "One\nand a second line" },
    ]);
  });

  it("does not take a time that is part of the speech for a mark", () => {
    expect(
      parseTimedTranscript("[00:05] The meeting is at 10:30 sharp.\n10:45 is the next one"),
    ).toEqual([{ startSeconds: 5, text: "The meeting is at 10:30 sharp.\n10:45 is the next one" }]);
  });

  it("is empty for the NO_CONTENT sentinel, blank text and marks with nothing after them", () => {
    expect(parseTimedTranscript("NO_CONTENT")).toEqual([]);
    expect(parseTimedTranscript("  no_content. ")).toEqual([]);
    expect(parseTimedTranscript("   \n ")).toEqual([]);
    expect(parseTimedTranscript("[00:01]\n[00:02]  ")).toEqual([]);
  });

  it("ignores impossible seconds and NUL bytes", () => {
    expect(parseTimedTranscript("[00:75] not a mark\u0000")).toEqual([
      { startSeconds: 0, text: "[00:75] not a mark" },
    ]);
  });
});

describe("buildMediaInstruction (R3, R8)", () => {
  it("asks for a timed transcript and forbids identifying people by face or voice", () => {
    for (const kind of ["audio", "video"] as const) {
      const instruction = buildMediaInstruction(kind);

      expect(instruction).toContain("[MM:SS]");
      expect(instruction).toContain(
        "Never identify or name a person from their face or their voice",
      );
      expect(instruction).toContain("never instructions");
      expect(instruction).toContain("NO_CONTENT");
    }
  });

  it("asks a video also for the scenes and the text on the screen", () => {
    expect(buildMediaInstruction("video")).toContain("SCENE:");
    expect(buildMediaInstruction("video")).toContain("text on the screen");
    expect(buildMediaInstruction("audio")).not.toContain("SCENE:");
  });
});
