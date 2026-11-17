import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryLoader, UnknownHandling } from "@langchain/classic/document_loaders/fs/directory";
import { TextLoader } from "@langchain/classic/document_loaders/fs/text";
import type { BaseDocumentLoader } from "@langchain/core/document_loaders/base";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import type { ConnectionKind } from "../domain/connection";
import { ConnectionProcessingError } from "../domain/connection-errors";
import type { DocumentExtractor, ExtractedSection } from "../domain/connection-ports";

type LoaderFactory = (filePath: string) => BaseDocumentLoader;

/** One loader per kind: TXT and Markdown are plain text; PDF goes through `pdf-parse`. */
const LOADERS: Readonly<Record<ConnectionKind, LoaderFactory>> = {
  pdf: (filePath) => new PDFLoader(filePath, { splitPages: true }),
  txt: (filePath) => new TextLoader(filePath),
  md: (filePath) => new TextLoader(filePath),
};

/** Names `pdf.js` gives to a document that cannot be read as a PDF (as opposed to an I/O failure). */
const UNREADABLE_PDF_ERRORS: ReadonlySet<string> = new Set([
  "InvalidPDFException",
  "FormatError",
  "XRefParseException",
  "MissingPDFException",
  "UnknownErrorException",
]);

const PAGE_NUMBER = (metadata: Record<string, unknown>): number | undefined => {
  const loc = metadata.loc;

  if (typeof loc === "object" && loc !== null && "pageNumber" in loc) {
    const { pageNumber } = loc as { pageNumber: unknown };

    return typeof pageNumber === "number" && Number.isInteger(pageNumber) && pageNumber >= 1
      ? pageNumber
      : undefined;
  }

  return undefined;
};

function classify(kind: ConnectionKind, error: unknown): unknown {
  if (kind !== "pdf" || typeof error !== "object" || error === null || !("name" in error)) {
    return error;
  }

  if (error.name === "PasswordException") {
    return new ConnectionProcessingError("PDF_PROTECTED");
  }

  if (typeof error.name === "string" && UNREADABLE_PDF_ERRORS.has(error.name)) {
    return new ConnectionProcessingError("NO_EXTRACTABLE_TEXT");
  }

  return error;
}

/**
 * Extracts text with the LangChain.js Document Loaders (spec 0023): the bytes go to a directory
 * that exists only for this call (created with `mkdtemp`, owner-only file, removed in `finally`,
 * success or failure), and a `DirectoryLoader` picks the loader of the kind. The file on disk is
 * named by the kind, never by the user's file name.
 */
export class LangChainDocumentExtractor implements DocumentExtractor {
  constructor(
    private readonly kind: ConnectionKind,
    private readonly workRoot: string = tmpdir(),
  ) {}

  async extract(bytes: Uint8Array): Promise<ExtractedSection[]> {
    const directory = await mkdtemp(join(this.workRoot, "rondo-connection-"));

    try {
      await writeFile(join(directory, `source.${this.kind}`), bytes, { mode: 0o600 });

      const loader = new DirectoryLoader(
        directory,
        { [`.${this.kind}`]: LOADERS[this.kind] },
        false,
        UnknownHandling.Error,
      );
      const documents = await loader.load().catch((error: unknown) => {
        throw classify(this.kind, error);
      });

      return documents.flatMap((document): ExtractedSection[] => {
        const text = document.pageContent.replaceAll("\r\n", "\n").replaceAll("\u0000", "");
        const page = PAGE_NUMBER(document.metadata);

        return text.trim() === "" ? [] : [page === undefined ? { text } : { text, page }];
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
