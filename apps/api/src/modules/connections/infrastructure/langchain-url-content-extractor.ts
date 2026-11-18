import { HtmlToTextTransformer } from "@langchain/community/document_transformers/html_to_text";
import { Document } from "@langchain/core/documents";
import { htmlToText, type HtmlToTextOptions } from "html-to-text";
import type { DocumentExtractor, ExtractedSection } from "../domain/connection-ports";
import { sanitizeDisplayName } from "../domain/external-url";
import type { FetchedPage, UrlContent, UrlContentExtractor } from "../domain/url-fetch";
import { LangChainDocumentExtractor } from "./langchain-document-extractor";

/** What is not the article: scripts, styles, navigation, the footer, side bars, forms and embeds. */
const SKIPPED = [
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "nav",
  "footer",
  "aside",
  "form",
  "img",
] as const;

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

const HTML_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    // The address of a link may hold a token: only the text of the link is kept.
    { selector: "a", options: { ignoreHref: true } },
    ...SKIPPED.map((selector) => ({ selector, format: "skip" })),
    ...HEADINGS.map((selector) => ({ selector, options: { uppercase: false } })),
  ],
};

const TITLE_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  baseElements: { selectors: ["title"], returnDomByDefault: false },
};

/** Decodes the body with the charset the server named (UTF-8 when it is unknown or absent). */
function decode(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const tidy = (text: string): string =>
  text
    .replaceAll("\r\n", "\n")
    .replaceAll("\u0000", "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Turns a fetched page into text (spec 0027, R5). It works on the bytes that were already
 * downloaded and never touches the network: the HTML goes through the LangChain.js
 * `HtmlToTextTransformer` (no script, style, navigation or footer; link addresses dropped), and a
 * PDF, a text file or Markdown go through the very same extractors as an uploaded file (spec 0023).
 */
export class LangChainUrlContentExtractor implements UrlContentExtractor {
  constructor(
    private readonly files: Readonly<Record<"pdf" | "txt" | "md", DocumentExtractor>> = {
      pdf: new LangChainDocumentExtractor("pdf"),
      txt: new LangChainDocumentExtractor("txt"),
      md: new LangChainDocumentExtractor("md"),
    },
  ) {}

  async extract(page: FetchedPage): Promise<UrlContent> {
    switch (page.mediaType) {
      case "application/pdf":
        return { sections: await this.files.pdf.extract(page.bytes) };
      case "text/markdown":
        return { sections: await this.files.md.extract(this.asUtf8(page)) };
      case "text/plain":
        return { sections: await this.files.txt.extract(this.asUtf8(page)) };
      case "text/html":
        return this.extractHtml(decode(page.bytes, page.charset));
    }
  }

  /** The text extractors read UTF-8: a page in another charset is converted first. */
  private asUtf8(page: FetchedPage): Uint8Array {
    return new TextEncoder().encode(decode(page.bytes, page.charset));
  }

  private async extractHtml(html: string): Promise<UrlContent> {
    const [document] = await new HtmlToTextTransformer(HTML_OPTIONS).transformDocuments([
      new Document({ pageContent: html }),
    ]);
    const text = tidy(document?.pageContent ?? "");
    const sections: ExtractedSection[] = text === "" ? [] : [{ text }];
    const title = sanitizeDisplayName(htmlToText(html, TITLE_OPTIONS), "");

    return title === "" ? { sections } : { sections, title };
  }
}
