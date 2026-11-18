import { CHUNK_SIZE } from "../domain/connection-rules";
import type { ExtractedSection, TextChunker } from "../domain/connection-ports";
import { RecursiveTextChunker } from "./recursive-text-chunker";

/**
 * The divider of the transcript of an audio or a video (spec 0028, R3). Each section is one
 * segment with the second it starts at. Consecutive segments are joined, one per line, until the
 * chunk would pass about 1,000 characters; the chunk keeps the start of its first segment, so the
 * citation says where the passage begins. A segment longer than a chunk is split on its own
 * (every piece keeps the same start) instead of being merged.
 */
export class TimedTextChunker implements TextChunker {
  constructor(private readonly splitter: TextChunker = new RecursiveTextChunker()) {}

  async chunk(sections: readonly ExtractedSection[]): Promise<ExtractedSection[]> {
    const chunks: ExtractedSection[] = [];
    let lines: string[] = [];
    let length = 0;
    let startSeconds = 0;

    const flush = () => {
      if (lines.length > 0) {
        chunks.push({ text: lines.join("\n"), startSeconds });
      }

      lines = [];
      length = 0;
    };

    for (const section of sections) {
      const text = section.text.trim();
      const start = section.startSeconds ?? 0;

      if (text === "") {
        continue;
      }

      if (text.length > CHUNK_SIZE) {
        flush();
        chunks.push(...(await this.splitter.chunk([{ text, startSeconds: start }])));
        continue;
      }

      if (lines.length > 0 && length + 1 + text.length > CHUNK_SIZE) {
        flush();
      }

      if (lines.length === 0) {
        startSeconds = start;
      }

      lines.push(text);
      length += (lines.length > 1 ? 1 : 0) + text.length;
    }

    flush();

    return chunks;
  }
}
