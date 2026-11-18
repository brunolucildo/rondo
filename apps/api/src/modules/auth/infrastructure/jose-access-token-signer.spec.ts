import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { JoseAccessTokenSigner } from "./jose-access-token-signer";

const SECRET = "unit-test-jwt-secret-0123456789-abcdefghij";
const SUB = "5f1b6c1e-2d3a-4e5f-8a9b-0c1d2e3f4a5b";
const SID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const ISSUED_AT = new Date(Date.now() - 60_000);
const EXPIRES_AT = new Date(Date.now() + 60_000);
const key = new TextEncoder().encode(SECRET);

function sign(
  payload: Record<string, unknown>,
  { subject = SUB, expires = EXPIRES_AT }: { subject?: string | null; expires?: Date | null } = {},
) {
  let builder = new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuedAt();

  if (subject !== null) {
    builder = builder.setSubject(subject);
  }

  if (expires !== null) {
    builder = builder.setExpirationTime(Math.floor(expires.getTime() / 1000));
  }

  return builder.sign(key);
}

describe("JoseAccessTokenSigner", () => {
  const signer = new JoseAccessTokenSigner(SECRET);

  it("verifies a token it signed and returns sub and sid", async () => {
    const token = await signer.sign({ sub: SUB, sid: SID }, ISSUED_AT, EXPIRES_AT);

    expect(await signer.verify(token)).toEqual({ sub: SUB, sid: SID });
  });

  it("judges the expiry against the clock it is given, not the machine clock", async () => {
    const issuedAt = new Date("2026-11-09T12:00:00.000Z");
    const expiresAt = new Date("2026-11-16T12:00:00.000Z");
    const token = await signer.sign({ sub: SUB, sid: SID }, issuedAt, expiresAt);

    expect(await signer.verify(token, new Date("2026-11-10T12:00:00.000Z"))).toEqual({
      sub: SUB,
      sid: SID,
    });
    expect(await signer.verify(token, new Date("2026-11-17T12:00:00.000Z"))).toBeNull();
  });

  it("refuses a secret shorter than 32 characters without echoing it", () => {
    const short = "a".repeat(31);

    expect(() => new JoseAccessTokenSigner(short)).toThrowError(/AUTH_JWT_SECRET/);
    expect(() => new JoseAccessTokenSigner(short)).not.toThrowError(new RegExp(short));
  });

  it("rejects a token signed with another secret", async () => {
    const other = new JoseAccessTokenSigner("another-secret-0123456789-abcdefghijklmnop");
    const token = await other.sign({ sub: SUB, sid: SID }, ISSUED_AT, EXPIRES_AT);

    expect(await signer.verify(token)).toBeNull();
  });

  it("rejects a token whose payload was tampered with", async () => {
    const token = await signer.sign({ sub: SUB, sid: SID }, ISSUED_AT, EXPIRES_AT);
    const [header, , signature] = token.split(".");
    const payload = Buffer.from(
      JSON.stringify({ sub: SUB, sid: "11111111-1111-4111-8111-111111111111", exp: 9_999_999_999 }),
    ).toString("base64url");

    expect(await signer.verify(`${header}.${payload}.${signature}`)).toBeNull();
  });

  it("rejects an unsigned (alg none) token", async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "none", typ: "JWT" })}.${encode({
      sub: SUB,
      sid: SID,
      iat: Math.floor(ISSUED_AT.getTime() / 1000),
      exp: Math.floor(EXPIRES_AT.getTime() / 1000),
    })}.`;

    expect(await signer.verify(token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signer.sign(
      { sub: SUB, sid: SID },
      new Date(Date.now() - 120_000),
      new Date(Date.now() - 60_000),
    );

    expect(await signer.verify(token)).toBeNull();
  });

  it("rejects a token without sid", async () => {
    expect(await signer.verify(await sign({}))).toBeNull();
  });

  it("rejects a token without sub", async () => {
    expect(await signer.verify(await sign({ sid: SID }, { subject: null }))).toBeNull();
  });

  it("rejects a token without exp", async () => {
    expect(await signer.verify(await sign({ sid: SID }, { expires: null }))).toBeNull();
  });

  it("rejects ids that are not UUIDs (they would reach the database)", async () => {
    expect(await signer.verify(await sign({ sid: "1 or 1=1" }))).toBeNull();
    expect(await signer.verify(await sign({ sid: SID }, { subject: "not-a-uuid" }))).toBeNull();
    expect(await signer.verify(await sign({ sid: 42 }))).toBeNull();
  });

  it.each(["", "abc", "a.b.c", "Bearer x"])("rejects malformed input %j", async (token) => {
    expect(await signer.verify(token)).toBeNull();
  });
});
