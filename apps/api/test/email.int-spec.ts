import type { INestApplication } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configureApp, createNestApp } from "../src/bootstrap";
import { validateEnvironment } from "../src/config/environment";
import { baseLogger } from "../src/observability/logger";
import { EmailModule, EmailService, html, renderEmailLayout } from "../src/modules/email";
import { clearCapturedEmails, getCapturedEmails } from "../src/modules/email/testing";

const baseEnv = {
  DATABASE_URL: "postgres://rondo_app:rondo@localhost:5432/rondo",
  APP_URL: "http://localhost:5173",
  AUTH_JWT_SECRET: "test-only-jwt-secret-0123456789-abcdefghij",
};

describe("capture provider and the test-support route", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createNestApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    clearCapturedEmails();
  });

  it("send captures the message, readable by the helper and by the route, without network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { html: document, text } = renderEmailLayout({
      title: "Welcome",
      preheader: "Hi",
      bodyHtml: html`<p>Hello</p>`,
      bodyText: "Hello",
    });

    await app.get(EmailService).send({
      to: "Pat@Example.test",
      subject: "Welcome",
      text,
      html: document,
      purpose: "integration_test",
    });

    expect(getCapturedEmails({ to: "pat@example.test" })).toHaveLength(1);

    const response = await request(app.getHttpServer())
      .get("/api/v1/test-support/emails")
      .query({ to: "pat@example.test" });

    expect(response.status).toBe(200);
    expect(response.body.emails).toHaveLength(1);
    expect(response.body.emails[0]).toMatchObject({
      to: "Pat@Example.test",
      subject: "Welcome",
      purpose: "integration_test",
      from: { address: "no-reply@rondo.local" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("dispatch resolves at once and the message shows up after drain", async () => {
    const service = app.get(EmailService);

    await service.dispatch({ to: "sam@example.test", subject: "S", text: "t", html: "<p>t</p>" });
    await service.drain();

    expect(getCapturedEmails({ to: "sam@example.test" })).toHaveLength(1);
  });

  it("DELETE clears the mailbox and the filter by recipient narrows the list", async () => {
    const service = app.get(EmailService);

    await service.send({ to: "a@example.test", subject: "A", text: "t", html: "<p>t</p>" });
    await service.send({ to: "b@example.test", subject: "B", text: "t", html: "<p>t</p>" });

    const filtered = await request(app.getHttpServer())
      .get("/api/v1/test-support/emails")
      .query({ to: "b@example.test" });

    expect(filtered.body.emails.map((email: { subject: string }) => email.subject)).toEqual(["B"]);

    const cleared = await request(app.getHttpServer()).delete("/api/v1/test-support/emails");

    expect(cleared.status).toBe(204);
    expect(getCapturedEmails()).toEqual([]);
  });
});

describe("the test-support route outside capture mode", () => {
  it("answers 404 in the error envelope when NODE_ENV selects mailtrap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logSpy = vi.spyOn(baseLogger, "info");
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: () =>
            validateEnvironment({
              ...baseEnv,
              NODE_ENV: "dev",
              EMAIL_FROM: "no-reply@rondo.local",
              MAILTRAP_API_TOKEN: "test-token",
              MAILTRAP_INBOX_ID: "1",
            }),
        }),
        EmailModule,
      ],
    }).compile();
    const app = configureApp(moduleRef.createNestApplication());

    await app.init();

    try {
      const response = await request(app.getHttpServer()).get("/api/v1/test-support/emails");

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
      expect(fetchSpy).not.toHaveBeenCalled();
      // The boot log names the provider and NODE_ENV, and nothing else about the configuration.
      expect(logSpy).toHaveBeenCalledWith(
        { event: "email_provider_selected", provider: "mailtrap", nodeEnv: "dev" },
        expect.any(String),
      );
    } finally {
      await app.close();
      fetchSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("boot validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses to start in production without RESEND_API_KEY, even with a stale EMAIL_PROVIDER", async () => {
    // ConfigModule validates when AppModule is evaluated, so load it afresh.
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_PROVIDER", "capture");
    vi.stubEnv("RESEND_API_KEY", "");

    const boot = async () => {
      const { AppModule: FreshAppModule } = await import("../src/app.module.js");
      const moduleRef = await Test.createTestingModule({ imports: [FreshAppModule] }).compile();

      await moduleRef.init();
    };

    await expect(boot()).rejects.toThrowError(/RESEND_API_KEY/);
  });
});
