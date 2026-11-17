import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/bootstrap";
import { SessionService } from "../src/modules/auth/application/services/session.service";
import { EXPERTS } from "../src/modules/experts/domain/expert-catalog";
import { buildSystemPrompt } from "../src/modules/experts/domain/expert-conversation";
import {
  SCRIPTED_ANSWER,
  SCRIPTED_FAIL_MARKER,
  SCRIPTED_SLOW_MARKER,
} from "../src/modules/experts/infrastructure/scripted-chat-model";
import { baseLogger } from "../src/observability/logger";
import { resetRateLimitStore } from "./support/rate-limit";
import { seedConfirmedUser } from "./support/sessions";
import { answerText, parseSse, readText } from "./support/sse";
import { type TelemetryRecorder, startTelemetryRecorder } from "./support/telemetry";
import { assertMigrationsApplied, deleteUsersByEmail } from "./support/database";

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

type LogFields = Record<string, unknown>;

/** JSON that survives the circular request and response objects pino-http hands to the logger. */
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();

  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) {
        return "[circular]";
      }

      seen.add(item);
    }

    return item;
  });
}

/**
 * The real API with the real LangGraph graph on top of the scripted model that `NODE_ENV=test`
 * selects (no OpenAI, no network): the path the E2E runs, and the one that must keep message
 * content out of every log and span (R10).
 */
describe("experts chat on the real graph with the scripted model", () => {
  const createdEmails: string[] = [];
  const artifacts: string[] = [];
  let recorder: TelemetryRecorder;
  let app: INestApplication;
  let token: string;
  const spies = {
    info: vi.spyOn(baseLogger, "info"),
    warn: vi.spyOn(baseLogger, "warn"),
    error: vi.spyOn(baseLogger, "error"),
    debug: vi.spyOn(baseLogger, "debug"),
  };

  // pino-http hands the raw request and response to the logger and its serializers cut them down
  // to id, method, path and status before anything is written; the raw objects (which carry the
  // parsed body) are therefore not what leaves the process, so they are left out here.
  const logs = (): LogFields[] =>
    Object.values(spies).flatMap((spy) =>
      spy.mock.calls.map(([fields]) => {
        const { req: _req, res: _res, ...written } = fields as LogFields;

        return written;
      }),
    );
  const expertLogs = () => logs().filter((fields) => fields?.event === "expert_message");

  const send = (expertId: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`/api/v1/experts/${expertId}/messages`)
      .set(bearer(token))
      .buffer(true)
      .parse(readText)
      .send(body as object);

  beforeAll(async () => {
    await assertMigrationsApplied();
    recorder = startTelemetryRecorder();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const user = await seedConfirmedUser("experts-chat");

    createdEmails.push(user.email);
    token = (await app.get(SessionService).issue(user.id)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await recorder.stop();
    await deleteUsersByEmail(createdEmails);
  });

  beforeEach(() => {
    resetRateLimitStore(app);
    recorder.reset();

    for (const spy of Object.values(spies)) {
      spy.mockClear();
    }
  });

  afterEach(() => {
    artifacts.push(safeJson({ spans: recorder.exportedSpans(), logs: logs() }));
  });

  it("streams the scripted answer through LangGraph in several pieces (R5, R6)", async () => {
    const response = await send("head-coach", { content: "Qual escalação para o clássico?" });
    const events = parseSse(response.body as string);

    expect(response.status).toBe(200);
    expect(events.filter((event) => event.event === "delta").length).toBeGreaterThan(3);
    expect(events.at(-1)).toEqual({ event: "done", data: {} });
    expect(answerText(events)).toBe(SCRIPTED_ANSWER);
  });

  it("answers every expert of the catalog", async () => {
    for (const expert of EXPERTS) {
      const response = await send(expert.id, { content: "Olá" });

      expect(answerText(parseSse(response.body as string))).toBe(SCRIPTED_ANSWER);
    }
  });

  it("turns a model failure into a typed error event (after one retry)", async () => {
    const failed = await send("head-coach", { content: `quebre ${SCRIPTED_FAIL_MARKER}` });

    expect(parseSse(failed.body as string)).toEqual([
      {
        event: "error",
        data: { code: "EXPERT_ANSWER_FAILED", message: "The expert couldn't answer." },
      },
    ]);
  });

  it("stops the scripted slow answer when the client leaves, long before it would end", async () => {
    const started = Date.now();
    const server = app.getHttpServer();

    await app.listen(0);

    const { port } = server.address() as { port: number };
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/experts/head-coach/messages`, {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ content: `devagar ${SCRIPTED_SLOW_MARKER}` }),
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const first = await reader?.read();

    expect(new TextDecoder().decode(first?.value)).toContain("event: delta");
    controller.abort();
    await reader?.cancel().catch(() => undefined);

    // Every `[slow]` piece takes 150 ms (60 s in all): the log below only appears once it stopped.
    await vi.waitFor(() => expect(expertLogs()).toHaveLength(1), { timeout: 3000 });
    expect(expertLogs()[0]).toMatchObject({ outcome: "aborted", reason: "aborted" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("writes one expert_message log per answer with ids, outcome, duration and tokens (R10)", async () => {
    await send("physiologist", { content: "Olá" });
    await send("head-coach", { content: `falhe ${SCRIPTED_FAIL_MARKER}` });

    const [success, failure] = expertLogs();

    expect(success).toMatchObject({
      event: "expert_message",
      expertId: "physiologist",
      outcome: "success",
      reason: "none",
      inputTokens: 12,
    });
    expect(typeof success?.durationMs).toBe("number");
    expect(typeof success?.outputTokens).toBe("number");
    expect(failure).toMatchObject({
      expertId: "head-coach",
      outcome: "failure",
      reason: "provider_error",
    });
    expect(Object.keys(success ?? {}).sort()).toEqual([
      "durationMs",
      "event",
      "expertId",
      "inputTokens",
      "outcome",
      "outputTokens",
      "reason",
      "requestId",
    ]);
  });

  it("opens the span expert.message with the expert id and the outcome only (R10)", async () => {
    await send("sports-lawyer", { content: "Olá" });

    const span = recorder.spans().find((candidate) => candidate.name === "expert.message");

    expect(span?.attributes).toMatchObject({
      "expert.id": "sports-lawyer",
      "expert.outcome": "success",
      "expert.reason": "none",
    });
  });

  it("never lets message content, history, the system prompt or a key reach a log or span (R10)", async () => {
    const sentinel = `SENTINEL-${randomUUID()}`;
    const historySentinel = `HISTORY-${randomUUID()}`;
    const expert = EXPERTS.find((candidate) => candidate.id === "sports-physician");

    await send("sports-physician", {
      content: `${sentinel} Que remédio devo tomar?`,
      history: [
        { role: "user", content: historySentinel },
        { role: "assistant", content: `${historySentinel} resposta` },
      ],
    });
    await send("sports-physician", { content: `${sentinel} ${SCRIPTED_FAIL_MARKER}` });
    await send("goalkeeper", { content: sentinel });
    await send("sports-physician", { content: "a".repeat(4001) + sentinel });
    artifacts.push(safeJson({ spans: recorder.exportedSpans(), logs: logs() }));

    const everything = artifacts.join("\n");

    for (const secret of [
      sentinel,
      historySentinel,
      buildSystemPrompt(expert!),
      expert!.persona.tone,
      expert!.persona.scope,
      token,
      process.env.AUTH_JWT_SECRET as string,
    ]) {
      expect(everything).not.toContain(secret);
    }

    expect(expertLogs().length).toBeGreaterThanOrEqual(2);
  });
});
