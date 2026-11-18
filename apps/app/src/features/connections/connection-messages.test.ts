import { describe, expect, it } from "vitest";
import {
  checkFileBeforeUpload,
  describeProcessingFailure,
  kindLabel,
  MAX_IMAGE_BYTES,
} from "./connection-messages";

const file = (name: string, size = 10) => {
  const created = new File(["x"], name);

  Object.defineProperty(created, "size", { value: size });

  return created;
};

describe("image messages (spec 0026)", () => {
  it("labels the image kind", () => {
    expect(kindLabel("image")).toBe("Image");
  });

  it("accepts .jpg, .jpeg and .png, in any case, and refuses other image formats", () => {
    for (const name of ["a.jpg", "a.JPEG", "A.PNG"]) {
      expect(checkFileBeforeUpload(file(name))).toBeNull();
    }

    for (const name of ["a.gif", "a.webp", "a.heic", "a.svg"]) {
      expect(checkFileBeforeUpload(file(name))?.text).toBe(
        "Only PDF, TXT, Markdown, JPG and PNG files are supported.",
      );
    }
  });

  it("limits an image to 10 MB and keeps 20 MB for the other files", () => {
    expect(checkFileBeforeUpload(file("a.png", MAX_IMAGE_BYTES))).toBeNull();
    expect(checkFileBeforeUpload(file("a.png", MAX_IMAGE_BYTES + 1))?.text).toBe(
      "Images can have at most 10 MB.",
    );
    expect(checkFileBeforeUpload(file("a.txt", MAX_IMAGE_BYTES + 1))).toBeNull();
  });

  it("uses the image wording for an image and the document wording for the rest", () => {
    expect(describeProcessingFailure("NO_EXTRACTABLE_TEXT", "image").text).toMatch(/this image/);
    expect(describeProcessingFailure("NO_EXTRACTABLE_TEXT", "pdf").text).toMatch(/Scanned PDFs/);
    expect(describeProcessingFailure("CONTENT_NOT_PROCESSABLE", "image").retryable).toBe(false);
    expect(describeProcessingFailure("PROCESSING_UNAVAILABLE", "image").retryable).toBe(true);
    expect(describeProcessingFailure("TOO_MANY_CHUNKS", "image").text).toMatch(/too long/);
  });
});
