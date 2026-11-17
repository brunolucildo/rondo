import { describe, expect, it } from "vitest";
import { CHUNK_SIZE } from "../domain/connection-rules";
import { sentences } from "../testing/pdf-fixtures";
import { RecursiveTextChunker } from "./recursive-text-chunker";

describe("RecursiveTextChunker", () => {
  const chunker = new RecursiveTextChunker();

  it("keeps a short text as one chunk", async () => {
    await expect(chunker.chunk([{ text: "Short note." }])).resolves.toEqual([
      { text: "Short note." },
    ]);
  });

  it("splits a long text into chunks of about 1,000 characters that overlap", async () => {
    const text = sentences("Alpha", 60);
    const chunks = await chunker.chunk([{ text }]);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.text.length <= CHUNK_SIZE)).toBe(true);

    // The overlap: the end of a chunk is repeated at the start of the next.
    const tail = chunks[0]?.text.slice(-40) ?? "";

    expect(chunks[1]?.text).toContain(tail.trim().split(" ").slice(-3).join(" "));
  });

  it("never mixes pages and keeps the page of every chunk", async () => {
    const chunks = await chunker.chunk([
      { text: sentences("One", 30), page: 1 },
      { text: "Page two is short.", page: 2 },
    ]);

    expect(chunks.filter((chunk) => chunk.page === 1).length).toBeGreaterThan(1);
    expect(chunks.at(-1)).toEqual({ text: "Page two is short.", page: 2 });
    expect(
      chunks.some((chunk) => chunk.text.includes("One") && chunk.text.includes("Page two")),
    ).toBe(false);
  });

  it("drops chunks that are only whitespace", async () => {
    await expect(chunker.chunk([{ text: "   " }])).resolves.toEqual([]);
  });
});
