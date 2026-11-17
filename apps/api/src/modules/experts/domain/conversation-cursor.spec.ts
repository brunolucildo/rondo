import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./conversation-cursor";

const ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

describe("conversation cursor", () => {
  it("round-trips a message id and is URL safe", () => {
    const cursor = encodeCursor(ID);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toBe(ID);
  });

  it.each(["", "not a cursor", "../../etc/passwd", "'; drop table x; --", "%00", "bm90LWEtdXVpZA"])(
    "refuses %j",
    (cursor) => {
      expect(decodeCursor(cursor)).toBeNull();
    },
  );

  it("refuses a base64url text that does not decode to a UUID", () => {
    expect(decodeCursor(Buffer.from("1; select 1", "utf8").toString("base64url"))).toBeNull();
  });
});
