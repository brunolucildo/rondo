import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { CHUNK_OVERLAP, CHUNK_SIZE } from "../domain/connection-rules";
import type { ExtractedSection, TextChunker } from "../domain/connection-ports";

/**
 * Splits each section (a page, or the whole text) on paragraph, line, sentence and word
 * boundaries into chunks of about 1,000 characters with 150 of overlap. A chunk never crosses a
 * page, so its `page` is exact; a section that starts at a second keeps it on every piece.
 */
export class RecursiveTextChunker implements TextChunker {
  private readonly splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  async chunk(sections: readonly ExtractedSection[]): Promise<ExtractedSection[]> {
    const chunks: ExtractedSection[] = [];

    for (const section of sections) {
      for (const text of await this.splitter.splitText(section.text)) {
        if (text.trim() !== "") {
          chunks.push({
            text,
            ...(section.page === undefined ? {} : { page: section.page }),
            ...(section.startSeconds === undefined ? {} : { startSeconds: section.startSeconds }),
          });
        }
      }
    }

    return chunks;
  }
}
