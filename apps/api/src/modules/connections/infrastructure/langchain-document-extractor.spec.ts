import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionProcessingError } from "../domain/connection-errors";
import { buildPdf, buildProtectedPdf } from "../testing/pdf-fixtures";
import { LangChainDocumentExtractor } from "./langchain-document-extractor";

describe("LangChainDocumentExtractor", () => {
  let workRoot: string;

  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), "extractor-spec-"));
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  const leftovers = () => readdir(workRoot);

  it("reads a PDF page by page, keeping the page numbers", async () => {
    const sections = await new LangChainDocumentExtractor("pdf", workRoot).extract(
      buildPdf([["First page text"], ["Second page text"], ["Third page text"]]),
    );

    expect(sections.map((section) => section.page)).toEqual([1, 2, 3]);
    expect(sections[0]?.text).toContain("First page text");
    expect(sections[2]?.text).toContain("Third page text");
    expect(await leftovers()).toEqual([]);
  });

  it("returns nothing for a PDF whose pages have no text (a scan)", async () => {
    const sections = await new LangChainDocumentExtractor("pdf", workRoot).extract(
      buildPdf([[], []]),
    );

    expect(sections).toEqual([]);
    expect(await leftovers()).toEqual([]);
  });

  it("fails with PDF_PROTECTED for a PDF that needs a password, and still cleans up", async () => {
    await expect(
      new LangChainDocumentExtractor("pdf", workRoot).extract(buildProtectedPdf()),
    ).rejects.toMatchObject({ name: "ConnectionProcessingError", code: "PDF_PROTECTED" });
    expect(await leftovers()).toEqual([]);
  });

  it("fails with NO_EXTRACTABLE_TEXT for bytes that only look like a PDF, and still cleans up", async () => {
    const error = await new LangChainDocumentExtractor("pdf", workRoot)
      .extract(Buffer.from("%PDF-1.4\nthis is not a real document\n"))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConnectionProcessingError);
    expect(error).toMatchObject({ code: "NO_EXTRACTABLE_TEXT" });
    expect(await leftovers()).toEqual([]);
  });

  it.each(["txt", "md"] as const)("reads %s as one text section without a page", async (kind) => {
    const sections = await new LangChainDocumentExtractor(kind, workRoot).extract(
      Buffer.from("# Title\r\n\r\nSome **text** here.\r\n", "utf8"),
    );

    expect(sections).toEqual([{ text: "# Title\n\nSome **text** here.\n" }]);
    expect(await leftovers()).toEqual([]);
  });

  it("skips a text that is only whitespace", async () => {
    const sections = await new LangChainDocumentExtractor("txt", workRoot).extract(
      Buffer.from("  \n\n  "),
    );

    expect(sections).toEqual([]);
  });
});
