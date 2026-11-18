import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTelemetryRecorder, type TelemetryRecorder } from "../../test/support/telemetry";
import { EXPERTS } from "../modules/experts/domain/expert-catalog";
import {
  EXPERT_LABELS,
  expertLabelOf,
  type ExpertMessageResult,
  recordExpertGrounded,
  recordExpertRetrieval,
  traceExpertMessage,
} from "./expert-telemetry";
import { baseLogger } from "./logger";

const SENTINEL = "SENTINEL-expert-id-5521";

const success = (usage: [number, number] | null = [120, 80]): ExpertMessageResult => ({
  outcome: "success",
  reason: "none",
  inputTokens: usage?.[0] ?? null,
  outputTokens: usage?.[1] ?? null,
});

describe("expert telemetry (spec 0029)", () => {
  let recorder: TelemetryRecorder;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    recorder = startTelemetryRecorder();
  });

  afterAll(async () => {
    await recorder.stop();
  });

  beforeEach(() => {
    recorder.reset();
    infoSpy = vi.spyOn(baseLogger, "info").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(baseLogger, "warn").mockImplementation(() => undefined);
  });

  const logged = (event: string) =>
    [...infoSpy.mock.calls, ...warnSpy.mock.calls]
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .filter((fields: Record<string, unknown>) => fields.event === event);

  it("keeps the closed list of expert labels equal to the catalog", () => {
    expect([...EXPERT_LABELS].sort()).toEqual(EXPERTS.map((expert) => expert.id).sort());
    expect(expertLabelOf("head-coach")).toBe("head-coach");
    expect(expertLabelOf(SENTINEL)).toBe("unknown");
  });

  it("records the duration with the closed labels `expert` and `outcome` only", async () => {
    await traceExpertMessage({ expertId: "physiologist" }, () => Promise.resolve(success()));
    await traceExpertMessage({ expertId: SENTINEL }, () => Promise.resolve(success()));

    const points = await recorder.metric("expert.message.duration");

    expect(points.map((point) => point.attributes)).toEqual([
      { expert: "physiologist", outcome: "success" },
      { expert: "unknown", outcome: "success" },
    ]);
    expect(points[0]?.boundaries?.at(-1)).toBe(120);
    expect(JSON.stringify([points, recorder.exportedSpans()])).not.toContain("SENTINEL-expert-id");
  });

  it("sums the tokens the provider reported, by direction, and nothing else", async () => {
    await traceExpertMessage({ expertId: "head-coach" }, () => Promise.resolve(success([120, 80])));

    const points = await recorder.metric("expert.llm.tokens");

    expect(
      points
        .map((point) => [point.attributes.expert, point.attributes.direction, point.value])
        .sort(),
    ).toEqual([
      ["head-coach", "input", 120],
      ["head-coach", "output", 80],
    ]);
    expect(points.map((point) => Object.keys(point.attributes).sort())).toEqual([
      ["direction", "expert"],
      ["direction", "expert"],
    ]);
  });

  it("does not invent tokens when the provider reports none and logs expert_usage_unavailable", async () => {
    await traceExpertMessage({ expertId: "head-coach" }, () => Promise.resolve(success(null)));

    expect(await recorder.metric("expert.llm.tokens")).toEqual([]);
    expect(logged("expert_usage_unavailable")).toHaveLength(1);
    expect(logged("expert_usage_unavailable")[0]).not.toHaveProperty("requestId");
  });

  it("measures the first token once per message, from the start of the request", async () => {
    const startedAt = performance.now() - 1500;

    await traceExpertMessage({ expertId: "head-coach", startedAt }, (probe) => {
      probe.firstToken();
      probe.firstToken();
      probe.firstToken();

      return Promise.resolve(success());
    });

    const [point] = await recorder.metric("expert.first_token");

    expect(point?.attributes).toEqual({ expert: "head-coach" });
    expect(point?.value).toBe(1);
    expect(point?.sum).toBeGreaterThanOrEqual(1.5);
  });

  it("marks only a real failure as an error and gives it the closed error code", async () => {
    const failure: ExpertMessageResult = {
      ...success(null),
      outcome: "failure",
      reason: "timeout",
    };
    const aborted: ExpertMessageResult = {
      ...success(null),
      outcome: "aborted",
      reason: "aborted",
    };

    await traceExpertMessage({ expertId: "head-coach" }, () => Promise.resolve(failure));
    await traceExpertMessage({ expertId: "head-coach" }, () => Promise.resolve(aborted));
    await traceExpertMessage({ expertId: "head-coach" }, () => Promise.resolve(success()));

    const [failed, stopped, fine] = recorder.spans();

    expect(failed?.status.code).toBe(2);
    expect(failed?.attributes).toMatchObject({
      "expert.outcome": "failure",
      "expert.error_code": "timeout",
    });
    expect(stopped?.status.code).toBe(0);
    expect(stopped?.attributes).toMatchObject({ "expert.outcome": "aborted" });
    expect(stopped?.attributes).not.toHaveProperty("expert.error_code");
    expect(fine?.attributes).not.toHaveProperty("expert.error_code");
    // An answer that does not report usage is not a failure: only a successful one logs it.
    expect(logged("expert_usage_unavailable")).toHaveLength(0);
  });

  it("treats a thrown run as a provider failure instead of throwing", async () => {
    const result = await traceExpertMessage({ expertId: "head-coach" }, () =>
      Promise.reject(new Error(`boom ${SENTINEL}`)),
    );

    expect(result).toMatchObject({ outcome: "failure", reason: "provider_error" });
    expect(JSON.stringify(recorder.exportedSpans())).not.toContain(SENTINEL);
  });

  it("writes the expert_message log with the trace and span ids of the answer span", async () => {
    await traceExpertMessage({ expertId: "head-coach", requestId: "req-1" }, () =>
      Promise.resolve(success()),
    );

    const [span] = recorder.spans();
    const [line] = logged("expert_message");

    expect(line).toMatchObject({
      trace_id: span?.spanContext().traceId,
      span_id: span?.spanContext().spanId,
      requestId: "req-1",
    });
  });

  it("counts answers by grounding with a closed label", async () => {
    recordExpertGrounded("yes");
    recordExpertGrounded("gap");
    recordExpertGrounded("skipped");
    recordExpertGrounded("skipped");

    const points = await recorder.metric("expert.grounded");

    expect(points.map((point) => [point.attributes.grounded, point.value]).sort()).toEqual([
      ["gap", 1],
      ["skipped", 2],
      ["yes", 1],
    ]);
  });

  it("records the hits of a retrieval under `all` or `attached`, and only when it ran to the end", async () => {
    recordExpertRetrieval({
      outcome: "found",
      scope: "connections",
      reason: "none",
      chunks: 3,
      durationSeconds: 0.1,
    });
    recordExpertRetrieval({
      outcome: "gap",
      scope: "all",
      reason: "none",
      chunks: 0,
      durationSeconds: 0.1,
    });
    recordExpertRetrieval({
      outcome: "failure",
      scope: "all",
      reason: "timeout",
      chunks: 0,
      durationSeconds: 0.1,
    });

    const points = await recorder.metric("expert.retrieval.hits");

    expect(points.map((point) => point.attributes)).toEqual([
      { scope: "attached" },
      { scope: "all" },
    ]);
    expect(points.map((point) => point.value)).toEqual([1, 1]);
  });
});
