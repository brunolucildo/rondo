import { describe, expect, it } from "vitest";
import { buildJpeg, buildPng } from "../testing";
import { isAcceptedUpload, kindOfFileName, MAX_IMAGE_BYTES } from "./connection-rules";
import { InvalidUploadError, type InvalidUploadCode } from "./connection-errors";
import { detectImageMimeType, readImageInfo } from "./image-format";
import { assertUploadContent } from "./upload-validation";

const codeOf = (run: () => void): InvalidUploadCode | null => {
  try {
    run();

    return null;
  } catch (error) {
    return error instanceof InvalidUploadError ? error.code : null;
  }
};

describe("image kinds by file name (R1)", () => {
  it.each(["photo.jpg", "photo.JPEG", "scan.png", "a.b.PNG"])("reads %s as an image", (name) => {
    expect(kindOfFileName(name)).toBe("image");
  });

  it.each(["anim.gif", "photo.webp", "photo.heic", "logo.svg", "scan.tiff", "photo.jpg.exe"])(
    "refuses %s",
    (name) => {
      expect(kindOfFileName(name)).toBeNull();
    },
  );

  it("accepts the image content types, with the generic ones, and nothing else for an image", () => {
    for (const type of [
      "image/jpeg",
      "image/png",
      "image/png; foo=bar",
      "application/octet-stream",
      "",
    ]) {
      expect(isAcceptedUpload("a.png", type)).toBe(true);
    }

    expect(isAcceptedUpload("a.png", "image/gif")).toBe(false);
    expect(isAcceptedUpload("a.jpg", "application/pdf")).toBe(false);
    expect(isAcceptedUpload("a.jpg", "text/plain")).toBe(false);
  });
});

describe("image signature and size (R1)", () => {
  it("reads the format and the pixel size of a PNG and of a JPEG", () => {
    expect(readImageInfo(buildPng({ width: 120, height: 80 }))).toEqual({
      mimeType: "image/png",
      width: 120,
      height: 80,
    });
    expect(readImageInfo(buildJpeg({ width: 640, height: 480 }))).toEqual({
      mimeType: "image/jpeg",
      width: 640,
      height: 480,
    });
  });

  it("tells the format by the signature only", () => {
    expect(detectImageMimeType(Buffer.from("GIF89a....."))).toBeNull();
    expect(detectImageMimeType(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
    expect(detectImageMimeType(buildJpeg())).toBe("image/jpeg");
  });

  it("gives no size for a damaged header instead of throwing", () => {
    expect(readImageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeNull();
    expect(readImageInfo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
    expect(readImageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x00]))).toBeNull();
  });

  it("accepts a valid JPEG and PNG", () => {
    expect(codeOf(() => assertUploadContent("image", buildPng()))).toBeNull();
    expect(codeOf(() => assertUploadContent("image", buildJpeg()))).toBeNull();
    expect(
      codeOf(() => assertUploadContent("image", buildPng({ width: 8000, height: 8000 }))),
    ).toBeNull();
  });

  it("refuses a GIF renamed to .png, a PDF and plain text by their bytes", () => {
    expect(
      codeOf(() => assertUploadContent("image", Buffer.from("GIF89a\u0001\u0000\u0001\u0000"))),
    ).toBe("UNSUPPORTED_FILE");
    expect(codeOf(() => assertUploadContent("image", Buffer.from("%PDF-1.4 ...")))).toBe(
      "UNSUPPORTED_FILE",
    );
    expect(codeOf(() => assertUploadContent("image", Buffer.from("just text")))).toBe(
      "UNSUPPORTED_FILE",
    );
  });

  it("refuses an image whose header does not give a size", () => {
    expect(codeOf(() => assertUploadContent("image", Buffer.from([0xff, 0xd8, 0xff, 0xe0])))).toBe(
      "UNSUPPORTED_FILE",
    );
    expect(codeOf(() => assertUploadContent("image", buildPng({ width: 0, height: 10 })))).toBe(
      "UNSUPPORTED_FILE",
    );
  });

  it("answers IMAGE_TOO_LARGE above 8,000 px on any side", () => {
    expect(
      codeOf(() => assertUploadContent("image", buildPng({ width: 9000, height: 9000 }))),
    ).toBe("IMAGE_TOO_LARGE");
    expect(codeOf(() => assertUploadContent("image", buildJpeg({ width: 8001, height: 10 })))).toBe(
      "IMAGE_TOO_LARGE",
    );
    expect(codeOf(() => assertUploadContent("image", buildJpeg({ width: 10, height: 8001 })))).toBe(
      "IMAGE_TOO_LARGE",
    );
  });

  it("answers FILE_TOO_LARGE above 10 MB and EMPTY_FILE for no bytes", () => {
    const big = Buffer.concat([buildPng(), Buffer.alloc(MAX_IMAGE_BYTES)]);

    expect(codeOf(() => assertUploadContent("image", big))).toBe("FILE_TOO_LARGE");
    expect(codeOf(() => assertUploadContent("image", Buffer.alloc(0)))).toBe("EMPTY_FILE");
  });

  it("keeps the 20 MB limit for the other kinds", () => {
    const eleven = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x61);

    expect(codeOf(() => assertUploadContent("txt", eleven))).toBeNull();
  });
});
