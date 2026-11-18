import { describe, expect, it } from "vitest";
import { buildPdf, sentences, wrapLines } from "../testing/pdf-fixtures";
import { ConnectionProcessingError } from "../domain/connection-errors";
import type { FetchedPage } from "../domain/url-fetch";
import { LangChainUrlContentExtractor } from "./langchain-url-content-extractor";

const extractor = new LangChainUrlContentExtractor();
const html = (source: string, charset?: string): FetchedPage => ({
  bytes: new TextEncoder().encode(source),
  mediaType: "text/html",
  ...(charset === undefined ? {} : { charset }),
});
const joined = (sections: { text: string }[]) => sections.map((section) => section.text).join("\n");

describe("LangChainUrlContentExtractor: HTML (R5)", () => {
  const article = `<!doctype html><html><head><title> Regulation &amp; rules </title>
    <style>.menu{color:red}</style><script>var SCRIPT_NOISE = 1;</script></head>
    <body><nav><a href="/x?token=TOKEN-IN-HREF">MENU-NOISE</a></nav>
    <header><h1>Match regulation</h1></header>
    <main><article><h2>Substitutions</h2>
    <p>Each team may make <a href="https://x.test/?t=SECRET">five substitutions</a> per match.</p>
    <ul><li>First item</li><li>Second item</li></ul></article></main>
    <aside>ASIDE-NOISE</aside><footer>FOOTER-NOISE</footer>
    <form><input value="FORM-NOISE"></form><noscript>NOSCRIPT-NOISE</noscript></body></html>`;

  it("keeps the text of the article and nothing of the menu, scripts, styles and footer", async () => {
    const { sections, title } = await extractor.extract(html(article));
    const text = joined(sections);

    expect(title).toBe("Regulation & rules");
    expect(text).toContain("Match regulation");
    expect(text).toContain("Substitutions");
    expect(text).toContain("Each team may make five substitutions per match.");
    expect(text).toContain("First item");

    for (const noise of [
      "MENU-NOISE",
      "SCRIPT_NOISE",
      "ASIDE-NOISE",
      "FOOTER-NOISE",
      "FORM-NOISE",
      "NOSCRIPT-NOISE",
      "color:red",
    ]) {
      expect(text).not.toContain(noise);
    }
  });

  it("drops the address of links: a token in a link never reaches the text", async () => {
    const { sections } = await extractor.extract(html(article));
    const text = joined(sections);

    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("TOKEN-IN-HREF");
    expect(text).not.toContain("x.test");
  });

  it("does not shout the headings", async () => {
    const { sections } = await extractor.extract(
      html("<body><h1>Mixed Case Title</h1><p>text</p></body>"),
    );

    expect(joined(sections)).toContain("Mixed Case Title");
  });

  it("gives no sections for a page that only has JavaScript", async () => {
    const { sections } = await extractor.extract(
      html(
        '<html><head><title>App</title></head><body><div id="root"></div><script>render()</script></body></html>',
      ),
    );

    expect(sections).toEqual([]);
  });

  it("has no title when the page has none", async () => {
    const { title } = await extractor.extract(html("<body><p>just text</p></body>"));

    expect(title).toBeUndefined();
  });

  it("reads the charset the server named", async () => {
    const bytes = new Uint8Array([...Buffer.from("<p>coração ", "latin1"), ...Buffer.from("</p>")]);
    const { sections } = await extractor.extract({
      bytes,
      mediaType: "text/html",
      charset: "iso-8859-1",
    });

    expect(joined(sections)).toContain("coração");
  });

  it("falls back to UTF-8 for an unknown charset", async () => {
    const { sections } = await extractor.extract(html("<p>olá</p>", "not-a-charset"));

    expect(joined(sections)).toContain("olá");
  });

  it("never touches the network: the extractor has no fetch and works on bytes only", async () => {
    const original = globalThis.fetch;
    let calls = 0;

    globalThis.fetch = (() => {
      calls += 1;

      return Promise.reject(new Error("network is off"));
    }) as typeof fetch;

    try {
      await extractor.extract(
        html(
          '<body><img src="http://x.test/a.png"><a href="http://x.test">l</a><p>text</p></body>',
        ),
      );
    } finally {
      globalThis.fetch = original;
    }

    expect(calls).toBe(0);
  });
});

describe("LangChainUrlContentExtractor: text, Markdown and PDF share the extractors of the files (R5)", () => {
  it("reads plain text and Markdown", async () => {
    const text = await extractor.extract({
      bytes: new TextEncoder().encode("Plain text of the page.\r\nSecond line."),
      mediaType: "text/plain",
    });
    const markdown = await extractor.extract({
      bytes: new TextEncoder().encode("# Heading\n\nBody of the note."),
      mediaType: "text/markdown",
    });

    expect(joined(text.sections)).toBe("Plain text of the page.\nSecond line.");
    expect(joined(markdown.sections)).toContain("Body of the note.");
    expect(text.title).toBeUndefined();
  });

  it("converts a text in another charset to UTF-8 first", async () => {
    const { sections } = await extractor.extract({
      bytes: Buffer.from("ação", "latin1"),
      mediaType: "text/plain",
      charset: "iso-8859-1",
    });

    expect(joined(sections)).toBe("ação");
  });

  it("reads a PDF with its pages", async () => {
    const pdf = buildPdf([
      wrapLines(sentences("The first page", 5)),
      wrapLines(sentences("The second page", 5)),
    ]);
    const { sections } = await extractor.extract({ bytes: pdf, mediaType: "application/pdf" });

    expect(sections.map((section) => section.page)).toEqual([1, 2]);
  });

  it("says a broken PDF has no extractable text", async () => {
    await expect(
      extractor.extract({
        bytes: new TextEncoder().encode("%PDF-1.4 garbage"),
        mediaType: "application/pdf",
      }),
    ).rejects.toThrow(ConnectionProcessingError);
  });
});
