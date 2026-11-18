import { describe, expect, it } from "vitest";
import { CHUNK_SIZE } from "../domain/connection-rules";
import { RecursiveTextChunker } from "./recursive-text-chunker";
import { TimedTextChunker } from "./timed-text-chunker";

const chunker = new TimedTextChunker();

describe("TimedTextChunker (R3, R7)", () => {
  it("joins short segments into one chunk that starts where the first one does", async () => {
    const chunks = await chunker.chunk([
      { text: "First thing said.", startSeconds: 12 },
      { text: "Second thing said.", startSeconds: 20 },
    ]);

    expect(chunks).toEqual([{ text: "First thing said.\nSecond thing said.", startSeconds: 12 }]);
  });

  it("starts a new chunk when the next segment would pass the chunk size", async () => {
    const segment = (start: number) => ({ text: "x".repeat(400), startSeconds: start });
    const chunks = await chunker.chunk([segment(0), segment(30), segment(60), segment(90)]);

    expect(chunks.map((chunk) => chunk.startSeconds)).toEqual([0, 60]);
    expect(chunks.every((chunk) => chunk.text.length <= CHUNK_SIZE)).toBe(true);
  });

  it("splits a segment longer than a chunk on its own and keeps its start on every piece", async () => {
    const long = Array.from({ length: 60 }, (_, index) => `Sentence number ${index}.`).join(" ");
    const chunks = await chunker.chunk([
      { text: "Before.", startSeconds: 5 },
      { text: long, startSeconds: 750 },
      { text: "After.", startSeconds: 900 },
    ]);

    expect(chunks[0]).toEqual({ text: "Before.", startSeconds: 5 });
    expect(chunks.at(-1)).toEqual({ text: "After.", startSeconds: 900 });

    const pieces = chunks.slice(1, -1);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.startSeconds === 750)).toBe(true);
  });

  it("drops empty segments and gives nothing for an empty transcript", async () => {
    expect(await chunker.chunk([{ text: "   ", startSeconds: 1 }])).toEqual([]);
    expect(await chunker.chunk([])).toEqual([]);
  });
});

describe("RecursiveTextChunker with a start second", () => {
  it("keeps startSeconds on the pieces and still keeps the page of the others", async () => {
    const recursive = new RecursiveTextChunker();
    const [timed] = await recursive.chunk([{ text: "Spoken part.", startSeconds: 42 }]);
    const [paged] = await recursive.chunk([{ text: "Page part.", page: 3 }]);

    expect(timed).toEqual({ text: "Spoken part.", startSeconds: 42 });
    expect(paged).toEqual({ text: "Page part.", page: 3 });
  });
});
