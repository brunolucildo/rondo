import { describe, expect, it } from "vitest";
import { validateEnvironment } from "./environment";

const validEnv = {
  DATABASE_URL: "postgres://rondo_app:rondo@localhost:5432/rondo",
  APP_URL: "http://localhost:5173",
  NODE_ENV: "test",
  EMAIL_FROM: "Rondo <no-reply@rondo.local>",
  AUTH_JWT_SECRET: "unit-test-jwt-secret-0123456789-abcdefghij",
};

describe("validateEnvironment", () => {
  it("exposes APP_URL as the bare origin of the app", () => {
    const environment = validateEnvironment({
      ...validEnv,
      APP_URL: "https://app.example.com/ignored/path",
    });

    expect(environment.appUrl).toBe("https://app.example.com");
  });

  it("fails naming APP_URL when it is missing", () => {
    const { APP_URL: _removed, ...withoutAppUrl } = validEnv;

    expect(() => validateEnvironment(withoutAppUrl)).toThrowError(/APP_URL/);
  });

  it.each(["not-a-url", "ftp://localhost:5173", "localhost:5173", "javascript:alert(1)"])(
    "fails naming APP_URL when the value is %s",
    (value) => {
      expect(() => validateEnvironment({ ...validEnv, APP_URL: value })).toThrowError(/APP_URL/);
    },
  );

  describe("hash budget", () => {
    it("defaults to one slot below the default libuv thread pool and a queue of 64", () => {
      const environment = validateEnvironment(validEnv);

      expect(environment.authHashConcurrency).toBe(3);
      expect(environment.authHashQueueLimit).toBe(64);
    });

    it("follows UV_THREADPOOL_SIZE, always leaving one thread free", () => {
      expect(
        validateEnvironment({ ...validEnv, UV_THREADPOOL_SIZE: "8" }).authHashConcurrency,
      ).toBe(7);
      expect(
        validateEnvironment({ ...validEnv, UV_THREADPOOL_SIZE: "1" }).authHashConcurrency,
      ).toBe(1);
    });

    it("lets AUTH_HASH_CONCURRENCY and AUTH_HASH_QUEUE_LIMIT override the defaults", () => {
      const environment = validateEnvironment({
        ...validEnv,
        AUTH_HASH_CONCURRENCY: "2",
        AUTH_HASH_QUEUE_LIMIT: "0",
      });

      expect(environment.authHashConcurrency).toBe(2);
      expect(environment.authHashQueueLimit).toBe(0);
    });

    it.each([
      ["AUTH_HASH_CONCURRENCY", "0"],
      ["AUTH_HASH_CONCURRENCY", "2.5"],
      ["AUTH_HASH_CONCURRENCY", "many"],
      ["AUTH_HASH_QUEUE_LIMIT", "-1"],
      ["AUTH_HASH_QUEUE_LIMIT", "lots"],
      ["UV_THREADPOOL_SIZE", "0"],
    ])("fails naming %s when the value is %s", (name, value) => {
      expect(() => validateEnvironment({ ...validEnv, [name]: value })).toThrowError(
        new RegExp(name),
      );
    });
  });

  it("exposes the validated e-mail configuration", () => {
    expect(validateEnvironment(validEnv).email).toMatchObject({ provider: "capture" });
  });

  it("treats a missing NODE_ENV as dev and then needs the Mailtrap credentials", () => {
    const { NODE_ENV: _removed, ...withoutNodeEnv } = validEnv;

    expect(
      validateEnvironment({ ...withoutNodeEnv, MAILTRAP_API_TOKEN: "t", MAILTRAP_INBOX_ID: "1" }),
    ).toMatchObject({
      nodeEnv: "dev",
      email: { provider: "mailtrap" },
    });
    expect(() => validateEnvironment(withoutNodeEnv)).toThrowError(/MAILTRAP_/);
  });

  it("exposes the normalized NODE_ENV", () => {
    expect(validateEnvironment({ ...validEnv, NODE_ENV: " TEST " }).nodeEnv).toBe("test");
  });

  it("needs RESEND_API_KEY in production and ignores a stale EMAIL_PROVIDER", () => {
    const production = { ...validEnv, NODE_ENV: "production", EMAIL_PROVIDER: "capture" };

    expect(() => validateEnvironment(production)).toThrowError(/RESEND_API_KEY/);
    expect(validateEnvironment({ ...production, RESEND_API_KEY: "key" }).email).toMatchObject({
      provider: "resend",
    });
  });

  describe("expert chat model", () => {
    it("uses the scripted fake in test, whatever OPENAI_API_KEY says", () => {
      expect(validateEnvironment({ ...validEnv, OPENAI_API_KEY: "sk-test" }).expertChat).toEqual({
        provider: "fake",
      });
    });

    it("boots without OPENAI_API_KEY and reports the experts as unavailable", () => {
      const env = {
        ...validEnv,
        NODE_ENV: "production",
        RESEND_API_KEY: "re_test",
      };

      expect(validateEnvironment(env).expertChat).toEqual({ provider: "unavailable" });
    });

    it("reads OPENAI_API_KEY and OPENAI_CHAT_MODEL outside tests", () => {
      const env = { ...validEnv, NODE_ENV: "production", RESEND_API_KEY: "re_test" };

      expect(validateEnvironment({ ...env, OPENAI_API_KEY: "sk-x" }).expertChat).toEqual({
        provider: "openai",
        apiKey: "sk-x",
        model: "gpt-4o-mini",
      });
      expect(
        validateEnvironment({ ...env, OPENAI_API_KEY: "sk-x", OPENAI_CHAT_MODEL: "gpt-4o" })
          .expertChat,
      ).toMatchObject({ model: "gpt-4o" });
    });
  });

  it("exposes the database URL without changing it", () => {
    expect(validateEnvironment(validEnv).databaseUrl).toBe(validEnv.DATABASE_URL);
  });

  it("fails naming DATABASE_URL when it is missing", () => {
    const { DATABASE_URL: _removed, ...withoutDatabase } = validEnv;

    expect(() => validateEnvironment(withoutDatabase)).toThrowError(/DATABASE_URL/);
  });

  it.each([
    "not-a-url",
    "http://localhost:5432/rondo",
    "mysql://rondo@localhost:3306/rondo",
    "postgres://rondo_app:secret@localhost:5432",
    "postgres:///rondo",
  ])("fails naming DATABASE_URL when it is %s", (value) => {
    expect(() => validateEnvironment({ ...validEnv, DATABASE_URL: value })).toThrowError(
      /DATABASE_URL/,
    );
  });

  it("never echoes the DATABASE_URL value when it is invalid", () => {
    const secret = "super-secret-password-sentinel";

    expect(() =>
      validateEnvironment({ ...validEnv, DATABASE_URL: `mysql://user:${secret}@localhost/rondo` }),
    ).toThrowError(/DATABASE_URL/);
    expect(() =>
      validateEnvironment({ ...validEnv, DATABASE_URL: `mysql://user:${secret}@localhost/rondo` }),
    ).not.toThrowError(new RegExp(secret));
  });

  it("defaults TRUST_PROXY to false", () => {
    expect(validateEnvironment(validEnv).trustProxy).toBe(false);
  });

  it.each([
    ["true", true],
    ["TRUE", true],
    ["false", false],
  ])("reads TRUST_PROXY=%s as %s", (value, expected) => {
    expect(validateEnvironment({ ...validEnv, TRUST_PROXY: value }).trustProxy).toBe(expected);
  });

  it.each(["yes", "1", "maybe"])("fails naming TRUST_PROXY when the value is %s", (value) => {
    expect(() => validateEnvironment({ ...validEnv, TRUST_PROXY: value })).toThrowError(
      /TRUST_PROXY/,
    );
  });

  it("exposes the JWT secret", () => {
    expect(validateEnvironment(validEnv).authJwtSecret).toBe(validEnv.AUTH_JWT_SECRET);
  });

  it("accepts a secret of exactly 32 characters", () => {
    expect(() =>
      validateEnvironment({ ...validEnv, AUTH_JWT_SECRET: "x".repeat(32) }),
    ).not.toThrow();
  });

  it("fails naming AUTH_JWT_SECRET when it is missing", () => {
    const { AUTH_JWT_SECRET: _removed, ...withoutSecret } = validEnv;

    expect(() => validateEnvironment(withoutSecret)).toThrowError(/AUTH_JWT_SECRET/);
  });

  it("fails naming AUTH_JWT_SECRET, without echoing it, when it is shorter than 32 characters", () => {
    const short = "short-secret-31-characters-long";

    expect(short).toHaveLength(31);
    expect(() => validateEnvironment({ ...validEnv, AUTH_JWT_SECRET: short })).toThrowError(
      /AUTH_JWT_SECRET/,
    );
    expect(() => validateEnvironment({ ...validEnv, AUTH_JWT_SECRET: short })).not.toThrowError(
      new RegExp(short),
    );
  });
});
