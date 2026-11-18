import { describe, expect, it } from "vitest";
import { buildCitations, parseStoredCitations, type RetrievedChunk } from "./grounding";

const VIDEO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PDF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const timed = (overrides: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  connectionId: VIDEO,
  sourceName: "analysis.mp4",
  position: 3,
  startSeconds: 750,
  text: "The exit from the back starts here.",
  score: 0.8,
  ...overrides,
});

describe("citations of audio and video (spec 0028, R7)", () => {
  it("carries the second the best chunk starts at", () => {
    expect(buildCitations([timed()])).toEqual([
      {
        connectionId: VIDEO,
        sourceName: "analysis.mp4",
        page: null,
        position: 3,
        startSeconds: 750,
      },
    ]);
  });

  it("keeps each passage of the same media apart, so each instant can be checked, best first", () => {
    const citations = buildCitations([
      timed({ position: 1, startSeconds: 30, score: 0.4 }),
      timed({ position: 8, startSeconds: 750, score: 0.9 }),
      timed({ position: 9, startSeconds: 750, score: 0.5 }),
    ]);

    expect(citations.map((citation) => [citation.startSeconds, citation.position])).toEqual([
      [750, 8],
      [30, 1],
    ]);
  });

  it("leaves the citation of a document exactly as before: no startSeconds key", () => {
    const [citation] = buildCitations([
      { connectionId: PDF, sourceName: "plan.pdf", position: 2, page: 4, text: "x", score: 0.7 },
    ]);

    expect(citation).toEqual({ connectionId: PDF, sourceName: "plan.pdf", page: 4, position: 2 });
    expect("startSeconds" in (citation ?? {})).toBe(false);
  });

  it("reads a stored citation with its start and one without, and refuses a malformed start", () => {
    const stored = { connectionId: VIDEO, sourceName: "analysis.mp4", page: null, position: 3 };

    expect(parseStoredCitations([{ ...stored, startSeconds: 750 }])).toEqual([
      { ...stored, startSeconds: 750 },
    ]);
    expect(parseStoredCitations([stored])).toEqual([stored]);
    expect(parseStoredCitations([{ ...stored, startSeconds: null }])).toEqual([stored]);
    expect(parseStoredCitations([{ ...stored, startSeconds: -5 }])).toBeUndefined();
    expect(parseStoredCitations([{ ...stored, startSeconds: "12:30" }])).toBeUndefined();
  });

  it("drops what a stored row may hold besides the known keys (the chunk text never reaches a response)", () => {
    const [parsed] = parseStoredCitations([
      {
        connectionId: VIDEO,
        sourceName: "a.mp4",
        page: null,
        position: 1,
        startSeconds: 5,
        text: "SENTINEL",
      },
    ]) as object[];

    expect(JSON.stringify(parsed)).not.toContain("SENTINEL");
  });
});
