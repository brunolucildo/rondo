import { describe, expect, it } from "vitest";
import type { Connection } from "./connection";
import {
  isAcceptedUpload,
  isStaleProcessing,
  kindOfFileName,
  sanitizeFileName,
  STALE_PROCESSING_MS,
} from "./connection-rules";
import { InvalidUploadError } from "./connection-errors";
import { assertUploadContent } from "./upload-validation";

describe("kindOfFileName", () => {
  it.each([
    ["plan.pdf", "pdf"],
    ["PLAN.PDF", "pdf"],
    ["notes.txt", "txt"],
    ["readme.md", "md"],
    ["archive.tar.md", "md"],
  ] as const)("reads the kind of %s", (name, kind) => {
    expect(kindOfFileName(name)).toBe(kind);
  });

  it.each(["virus.exe", "picture.png", "noextension", "pdf", "trailing.", "doc.pdf.exe"])(
    "refuses %s",
    (name) => {
      expect(kindOfFileName(name)).toBeNull();
    },
  );
});

describe("isAcceptedUpload", () => {
  it("accepts the types of the three kinds, with or without parameters, and the generic ones", () => {
    for (const type of [
      "application/pdf",
      "text/plain",
      "text/plain; charset=utf-8",
      "text/markdown",
      "application/octet-stream",
      "",
    ]) {
      expect(isAcceptedUpload("a.pdf", type)).toBe(true);
    }
  });

  it("refuses another content type or another extension", () => {
    expect(isAcceptedUpload("a.pdf", "image/png")).toBe(false);
    expect(isAcceptedUpload("a.exe", "application/pdf")).toBe(false);
  });
});

describe("sanitizeFileName", () => {
  it("keeps only the base name and drops control characters", () => {
    expect(sanitizeFileName("C:\\docs\\..\\plan\u0000.pdf", "pdf")).toBe("plan.pdf");
    expect(sanitizeFileName("/etc/notes.txt", "txt")).toBe("notes.txt");
  });

  it("caps the name at 255 characters and falls back when nothing is left", () => {
    expect(Array.from(sanitizeFileName(`${"a".repeat(400)}.md`, "md"))).toHaveLength(255);
    expect(sanitizeFileName("   ", "md")).toBe("file.md");
  });
});

describe("assertUploadContent", () => {
  const code = (action: () => void): string | undefined => {
    try {
      action();
    } catch (error) {
      return error instanceof InvalidUploadError ? error.code : "OTHER";
    }

    return undefined;
  };

  it("accepts a PDF header, UTF-8 text and Markdown", () => {
    expect(code(() => assertUploadContent("pdf", Buffer.from("%PDF-1.7\n...")))).toBeUndefined();
    expect(
      code(() => assertUploadContent("txt", Buffer.from("olá, treino de força"))),
    ).toBeUndefined();
    expect(code(() => assertUploadContent("md", Buffer.from("# Title")))).toBeUndefined();
  });

  it("refuses an empty file", () => {
    expect(code(() => assertUploadContent("txt", Buffer.alloc(0)))).toBe("EMPTY_FILE");
  });

  it("refuses a file that is not what its extension says", () => {
    expect(code(() => assertUploadContent("pdf", Buffer.from("MZ\x90\x00 an executable")))).toBe(
      "UNSUPPORTED_FILE",
    );
    expect(code(() => assertUploadContent("txt", Buffer.from([0x68, 0x69, 0x00, 0x21])))).toBe(
      "UNSUPPORTED_FILE",
    );
    expect(code(() => assertUploadContent("md", Buffer.from([0xff, 0xfe, 0x41])))).toBe(
      "UNSUPPORTED_FILE",
    );
  });

  it("refuses a file above 20 MB", () => {
    expect(code(() => assertUploadContent("txt", Buffer.alloc(20 * 1024 * 1024 + 1, 0x61)))).toBe(
      "FILE_TOO_LARGE",
    );
  });
});

describe("isStaleProcessing", () => {
  const base: Connection = {
    id: "c1",
    userId: "u1",
    kind: "pdf",
    name: "a.pdf",
    sizeBytes: 10,
    contentHash: "0".repeat(64),
    status: "processing",
    chunkCount: 0,
    errorCode: null,
    createdAt: new Date("2026-11-17T10:00:00Z"),
    updatedAt: new Date("2026-11-17T10:00:00Z"),
  };
  const at = (ms: number) => new Date(base.updatedAt.getTime() + ms);

  it("is stale only after 15 minutes of processing", () => {
    expect(isStaleProcessing(base, at(STALE_PROCESSING_MS))).toBe(false);
    expect(isStaleProcessing(base, at(STALE_PROCESSING_MS + 1))).toBe(true);
    expect(isStaleProcessing({ ...base, status: "ready" }, at(STALE_PROCESSING_MS * 4))).toBe(
      false,
    );
  });
});
