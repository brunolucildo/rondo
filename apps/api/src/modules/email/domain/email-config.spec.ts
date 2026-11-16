import { describe, expect, it } from "vitest";
import {
  parseEmailConfig,
  parseEmailFrom,
  resolveNodeEnv,
  selectEmailProvider,
} from "./email-config";

const from = "Rondo <no-reply@rondo.local>";
const mailtrap = { MAILTRAP_API_TOKEN: "token-value", MAILTRAP_INBOX_ID: "123456" };

describe("resolveNodeEnv", () => {
  it.each([undefined, "", "   "])("defaults to dev when NODE_ENV is %j", (value) => {
    expect(resolveNodeEnv({ NODE_ENV: value })).toBe("dev");
  });

  it("trims and lower-cases the value", () => {
    expect(resolveNodeEnv({ NODE_ENV: " Production " })).toBe("production");
    expect(resolveNodeEnv({ NODE_ENV: "TEST" })).toBe("test");
  });
});

describe("selectEmailProvider", () => {
  it.each([
    ["production", "resend"],
    ["test", "capture"],
    ["dev", "mailtrap"],
    ["development", "mailtrap"],
    ["staging", "mailtrap"],
  ])("maps NODE_ENV=%s to %s", (nodeEnv, provider) => {
    expect(selectEmailProvider(nodeEnv)).toBe(provider);
  });
});

describe("parseEmailConfig", () => {
  it("captures in memory when NODE_ENV is test, without credentials", () => {
    expect(parseEmailConfig({ NODE_ENV: "test", EMAIL_FROM: from })).toEqual({
      provider: "capture",
      from: { name: "Rondo", address: "no-reply@rondo.local" },
    });
  });

  it.each([undefined, "", "dev", "development", "staging"])(
    "uses mailtrap when NODE_ENV is %j",
    (nodeEnv) => {
      expect(parseEmailConfig({ NODE_ENV: nodeEnv, EMAIL_FROM: from, ...mailtrap })).toMatchObject({
        provider: "mailtrap",
        apiToken: "token-value",
        inboxId: "123456",
      });
    },
  );

  it.each(["production", " Production "])("uses resend when NODE_ENV is %j", (nodeEnv) => {
    expect(
      parseEmailConfig({
        NODE_ENV: nodeEnv,
        EMAIL_FROM: "no-reply@example.com",
        RESEND_API_KEY: "key-value",
      }),
    ).toMatchObject({ provider: "resend", apiKey: "key-value" });
  });

  it("normalizes NODE_ENV before choosing the provider", () => {
    expect(parseEmailConfig({ NODE_ENV: "TEST", EMAIL_FROM: from })).toMatchObject({
      provider: "capture",
    });
  });

  it.each(["capture", "mailtrap", "smtp", ""])(
    "ignores EMAIL_PROVIDER=%j, in production and elsewhere",
    (value) => {
      expect(
        parseEmailConfig({
          NODE_ENV: "production",
          EMAIL_PROVIDER: value,
          EMAIL_FROM: from,
          RESEND_API_KEY: "key-value",
        }),
      ).toMatchObject({ provider: "resend" });
      expect(
        parseEmailConfig({ NODE_ENV: "test", EMAIL_PROVIDER: "resend", EMAIL_FROM: from }),
      ).toMatchObject({ provider: "capture" });
      expect(
        parseEmailConfig({ EMAIL_PROVIDER: value, EMAIL_FROM: from, ...mailtrap }),
      ).toMatchObject({ provider: "mailtrap" });
    },
  );

  it("never selects capture or mailtrap in production, whatever else is set", () => {
    const config = parseEmailConfig({
      NODE_ENV: "production",
      EMAIL_PROVIDER: "capture",
      EMAIL_FROM: from,
      RESEND_API_KEY: "key-value",
      ...mailtrap,
    });

    expect(config.provider).toBe("resend");
  });

  it.each([undefined, "", "not-an-address", "Name <broken>", "a@b"])(
    "fails naming EMAIL_FROM when it is %j",
    (value) => {
      expect(() => parseEmailConfig({ NODE_ENV: "test", EMAIL_FROM: value })).toThrowError(
        /EMAIL_FROM/,
      );
      expect(() =>
        parseEmailConfig({ NODE_ENV: "production", EMAIL_FROM: value, RESEND_API_KEY: "key" }),
      ).toThrowError(/EMAIL_FROM/);
      expect(() => parseEmailConfig({ EMAIL_FROM: value, ...mailtrap })).toThrowError(/EMAIL_FROM/);
    },
  );

  it.each([
    [{ MAILTRAP_INBOX_ID: "1" }, /MAILTRAP_API_TOKEN/],
    [{ MAILTRAP_API_TOKEN: "token-value" }, /MAILTRAP_INBOX_ID/],
    [{ MAILTRAP_API_TOKEN: "token-value", MAILTRAP_INBOX_ID: "abc" }, /MAILTRAP_INBOX_ID/],
  ])("fails naming the missing mailtrap variable (%j)", (extra, pattern) => {
    expect(() => parseEmailConfig({ EMAIL_FROM: from, ...extra })).toThrowError(pattern);
  });

  it("fails naming RESEND_API_KEY when it is missing in production", () => {
    expect(() => parseEmailConfig({ NODE_ENV: "production", EMAIL_FROM: from })).toThrowError(
      /RESEND_API_KEY/,
    );
  });

  it("does not echo credential values in errors", () => {
    expect(() =>
      parseEmailConfig({
        EMAIL_FROM: from,
        MAILTRAP_API_TOKEN: "super-secret-token",
        MAILTRAP_INBOX_ID: "not-numeric",
      }),
    ).toThrowError(expect.not.stringContaining("super-secret-token"));
  });
});

describe("parseEmailFrom", () => {
  it("parses a bare address and a quoted name", () => {
    expect(parseEmailFrom("no-reply@example.com")).toEqual({ address: "no-reply@example.com" });
    expect(parseEmailFrom('"Rondo" <no-reply@example.com>')).toEqual({
      name: "Rondo",
      address: "no-reply@example.com",
    });
  });
});
