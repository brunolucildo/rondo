/**
 * Builds tiny valid PDFs for tests, so no binary fixture or PDF library is needed. Each page is
 * a list of text lines in Helvetica; a page with no lines has no text at all (like a scanned page
 * without OCR).
 */

const escapeText = (line: string): string => line.replace(/[\\()]/g, (match) => `\\${match}`);

function pageContent(lines: readonly string[]): string {
  if (lines.length === 0) {
    return "";
  }

  const shown = lines.map((line) => `(${escapeText(line)}) Tj`).join("\n0 -16 Td\n");

  return `BT\n/F1 12 Tf\n72 720 Td\n${shown}\nET`;
}

/** `pages[0]` is page 1. ASCII text only (Helvetica with the standard encoding). */
export function buildPdf(pages: ReadonlyArray<readonly string[]>): Buffer {
  const pageIds = pages.map((_, index) => 4 + index * 2);
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  pages.forEach((lines, index) => {
    const content = pageContent(lines);
    const contentId = (pageIds[index] ?? 0) + 1;

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  });

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];

  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefAt = body.length;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`);

  body +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries.join("")}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(body, "latin1");
}

/** Wraps `text` into lines of at most `width` characters, so every line fits inside the page. */
export function wrapLines(text: string, width = 70): string[] {
  const lines: string[] = [];
  let line = "";

  for (const word of text.split(" ")) {
    if (line !== "" && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }

  return line === "" ? lines : [...lines, line];
}

/** A text of `count` distinct sentences: long enough to be split into several chunks. */
export function sentences(prefix: string, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `${prefix} sentence number ${index + 1} talks about training and recovery.`,
  ).join(" ");
}

/**
 * A two-page PDF encrypted with a user password (RC4 128, generated once with pypdf): opening it
 * needs the password, which the extractor does not have.
 */
export function buildProtectedPdf(): Buffer {
  return Buffer.from(
    [
      "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDNhOTM0NDFiYzQ+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9U",
      "eXBlIC9QYWdlcwovQ291bnQgMgovS2lkcyBbIDQgMCBSIDcgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0Nh",
      "dGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9NZWRpYUJveCBbIDAgMCA2MTIg",
      "NzkyIF0KL1Jlc291cmNlcyA8PAovRm9udCA8PAovRjEgNSAwIFIKPj4KPj4KL0NvbnRlbnRzIDYgMCBSCi9QYXJlbnQgMiAw",
      "IFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1R5cGUgL0ZvbnQKL1N1YnR5cGUgL1R5cGUxCi9CYXNlRm9udCAvSGVsdmV0aWNh",
      "Cj4+CmVuZG9iago2IDAgb2JqCjw8Ci9MZW5ndGggNDQKPj4Kc3RyZWFtCsCOjaUShnM7XpQBgO3BdwvdqrkNaqO7Z5Mxk9U9",
      "J3pYimPHqmJWWYjDOt1dCmVuZHN0cmVhbQplbmRvYmoKNyAwIG9iago8PAovVHlwZSAvUGFnZQovTWVkaWFCb3ggWyAwIDAg",
      "NjEyIDc5MiBdCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0YxIDUgMCBSCj4+Cj4+Ci9Db250ZW50cyA4IDAgUgovUGFyZW50",
      "IDIgMCBSCj4+CmVuZG9iago4IDAgb2JqCjw8Ci9MZW5ndGggMzkKPj4Kc3RyZWFtCn8UcaNd72xrFp9lnv+BnwjFPkyrlQKt",
      "GKnLuBLnTnJW6N8h+YTecAplbmRzdHJlYW0KZW5kb2JqCjkgMCBvYmoKPDwKL1YgMgovUiAzCi9MZW5ndGggMTI4Ci9QIDQy",
      "OTQ5NjcyOTIKL0ZpbHRlciAvU3RhbmRhcmQKL08gPDhjMzVlYzg3OGNhYTUwY2I0M2Y4MDA1Zjc5YjY2MWFhNGFlNDRmMGRj",
      "ZGZkY2NmMDcyMjRhNzU3ZDQzYTM3MzU+Ci9VIDw4ZTViZjBlZDM4Y2M1MTE0MzkzM2NmYTIwMDlmMzA1ZDI4YmY0ZTVlNGU3",
      "NThhNDE2NDAwNGU1NmZmZmEwMTA4Pgo+PgplbmRvYmoKeHJlZgowIDEwCjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAx",
      "NSAwMDAwMCBuIAowMDAwMDAwMDU5IDAwMDAwIG4gCjAwMDAwMDAxMjQgMDAwMDAgbiAKMDAwMDAwMDE3MyAwMDAwMCBuIAow",
      "MDAwMDAwMzAxIDAwMDAwIG4gCjAwMDAwMDAzNzEgMDAwMDAgbiAKMDAwMDAwMDQ2NSAwMDAwMCBuIAowMDAwMDAwNTkzIDAw",
      "MDAwIG4gCjAwMDAwMDA2ODIgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSAxMAovUm9vdCAzIDAgUgovSW5mbyAxIDAgUgov",
      "SUQgWyA8OTQ1Mzc2NDVlNGFlZDc2YmMyMWVhOGRkZWEwOGI1MjA+IDw5NDUzNzY0NWU0YWVkNzZiYzIxZWE4ZGRlYTA4YjUy",
      "MD4gXQovRW5jcnlwdCA5IDAgUgo+PgpzdGFydHhyZWYKODk3CiUlRU9GCg==",
    ].join(""),
    "base64",
  );
}
