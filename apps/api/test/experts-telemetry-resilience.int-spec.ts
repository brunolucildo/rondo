import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/bootstrap";
import { SessionService } from "../src/modules/auth/application/services/session.service";
import { EXPERT_ORCHESTRATOR } from "../src/modules/experts";
import { assertMigrationsApplied, deleteUsersByEmail, query } from "./support/database";
import { FakeExpertOrchestrator, speaks } from "./support/fake-expert-orchestrator";
import { resetRateLimitStore } from "./support/rate-limit";
import { seedConfirmedUser } from "./support/sessions";
import { parseSse, readText } from "./support/sse";

const MESSAGES = 25;
/** The telemetry may not add more than this to the p95 of an answer (spec 0029, R9). */
const MAX_EXTRA_P95_MS = 50;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

/**
 * The real SDK (`observability/telemetry.ts`, with its batch exporters) pointed at a Collector that
 * is down: the chat keeps answering, with no 5xx and no added latency. The SDK is started in the
 * middle of the file, so the answers before it are the baseline of the same process.
 */
describe("experts chat with the Collector down (R9)", () => {
  const createdEmails: string[] = [];
  let app: INestApplication;
  let token: string;
  let shutdown: (() => Promise<void>) | undefined;

  async function answers(): Promise<{ statuses: number[]; latencies: number[] }> {
    const statuses: number[] = [];
    const latencies: number[] = [];

    for (let count = 0; count < MESSAGES; count += 1) {
      resetRateLimitStore(app);

      const started = performance.now();
      const response = await request(app.getHttpServer())
        .post("/api/v1/experts/head-coach/messages")
        .set(bearer(token))
        .buffer(true)
        .parse(readText)
        .send({ content: `Pergunta ${count}` });

      latencies.push(performance.now() - started);
      statuses.push(response.status);
      expect(parseSse(response.body as string).at(-1)).toEqual({ event: "done", data: {} });
    }

    return { statuses, latencies };
  }

  beforeAll(async () => {
    await assertMigrationsApplied();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EXPERT_ORCHESTRATOR)
      .useValue(
        new FakeExpertOrchestrator(
          speaks(["Fake ", "answer."], { inputTokens: 5, outputTokens: 3 }),
        ),
      )
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const user = await seedConfirmedUser("telemetry-resilience");

    createdEmails.push(user.email);
    token = (await app.get(SessionService).issue(user.id)).accessToken;
  });

  afterAll(async () => {
    await shutdown?.().catch(() => undefined);
    await app.close();
    await query(
      "delete from public.expert_conversations where user_id in (select id from public.users where email = any($1))",
      [createdEmails],
    );
    await deleteUsersByEmail(createdEmails);
  });

  it("answers every message with no 5xx and no more than 50 ms of p95 added by the exporters", async () => {
    const baseline = await answers();

    // Port 9 (discard) refuses the connection at once: the Collector is "down".
    process.env.OTEL_SDK_DISABLED = "false";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:9";
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT = "500";

    const { sdk } = await import("../src/observability/telemetry.js");

    shutdown = () => sdk.shutdown();

    const withSdk = await answers();

    expect(withSdk.statuses.every((status) => status === 200)).toBe(true);
    expect(baseline.statuses.every((status) => status === 200)).toBe(true);
    expect(p95(withSdk.latencies) - p95(baseline.latencies)).toBeLessThanOrEqual(MAX_EXTRA_P95_MS);
  });
});
