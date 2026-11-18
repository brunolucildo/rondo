import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTelemetryRecorder, type TelemetryRecorder } from "../../test/support/telemetry";
import {
  EXPERT_DEPENDENCIES,
  modelFailureReason,
  recordDependencyCall,
  traceExpertNode,
  traceModelCall,
} from "./agent-telemetry";
import { baseLogger } from "./logger";

const SENTINEL = "SENTINEL-provider-message-8812";

describe("agent telemetry (spec 0029)", () => {
  let recorder: TelemetryRecorder;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    recorder = startTelemetryRecorder();
  });

  afterAll(async () => {
    await recorder.stop();
  });

  beforeEach(() => {
    recorder.reset();
    warnSpy = vi.spyOn(baseLogger, "warn").mockImplementation(() => undefined);
  });

  const failures = () =>
    warnSpy.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .filter((fields: Record<string, unknown>) => fields.event === "expert_dependency_failed");

  it("maps a provider error to a closed reason without reading its message", () => {
    const named = (name: string) => Object.assign(new Error(SENTINEL), { name });

    expect(modelFailureReason(Object.assign(new Error(SENTINEL), { status: 429 }))).toBe(
      "rate_limited",
    );
    expect(modelFailureReason(Object.assign(new Error(SENTINEL), { status: 401 }))).toBe(
      "unauthorized",
    );
    expect(modelFailureReason(Object.assign(new Error(SENTINEL), { status: 408 }))).toBe("timeout");
    expect(modelFailureReason(Object.assign(new Error(SENTINEL), { status: 503 }))).toBe(
      "server_error",
    );
    expect(modelFailureReason(Object.assign(new Error(SENTINEL), { status: 400 }))).toBe(
      "rejected",
    );
    expect(modelFailureReason(named("APIConnectionTimeoutError"))).toBe("timeout");
    expect(modelFailureReason(named("APIConnectionError"))).toBe("connection");
    expect(modelFailureReason(new Error(SENTINEL))).toBe("unknown");
    expect(modelFailureReason("not an error")).toBe("unknown");
  });

  it("counts a dependency call with the labels `dependency` and `outcome` only", async () => {
    recordDependencyCall("openai", "success", "none", 0.2);
    recordDependencyCall("weaviate", "failure", "connection", 0.4);

    const points = await recorder.metric("expert.dependency.calls");

    expect(points.map((point) => point.attributes)).toEqual([
      { dependency: "openai", outcome: "success" },
      { dependency: "weaviate", outcome: "failure" },
    ]);
    expect(EXPERT_DEPENDENCIES).toEqual(["openai", "weaviate", "gemini"]);
    // Only a failure is a log line, and it carries the closed reason and no content.
    expect(failures()).toEqual([
      expect.objectContaining({ dependency: "weaviate", reason: "connection", durationMs: 400 }),
    ]);
  });

  it("opens a node span that is an error only on a real failure", async () => {
    await traceExpertNode(
      "expert.retrieve",
      undefined,
      () => Promise.resolve(1),
      () => "x",
    );
    await expect(
      traceExpertNode(
        "expert.generate",
        undefined,
        () => Promise.reject(new Error(SENTINEL)),
        () => "provider_error",
      ),
    ).rejects.toThrow(SENTINEL);

    const [fine, failed] = recorder.spans();

    expect(fine?.status.code).toBe(0);
    expect(failed?.status.code).toBe(2);
    expect(failed?.attributes).toEqual({ "expert.error_code": "provider_error" });
    expect(JSON.stringify(recorder.exportedSpans())).not.toContain(SENTINEL);
  });

  it("does not count a stop pressed by the user as an error, in the node or in the model call", async () => {
    const stop = new AbortController();

    stop.abort();
    await expect(
      traceExpertNode(
        "expert.generate",
        stop.signal,
        () => traceModelCall("openai", stop.signal, () => Promise.reject(new Error("aborted"))),
        () => "provider_error",
      ),
    ).rejects.toThrow("aborted");

    for (const span of recorder.spans()) {
      expect(span.status.code).toBe(0);
      expect(span.attributes).not.toHaveProperty("expert.error_code");
    }

    expect(await recorder.metric("expert.dependency.calls")).toEqual([]);
    expect(failures()).toEqual([]);
  });

  it("wraps the model call in a CLIENT span with the operation and the provider only", async () => {
    await traceModelCall("openai", undefined, (span) => {
      span.setAttribute("gen_ai.usage.input_tokens", 12);

      return Promise.resolve("answer");
    });
    await expect(
      traceModelCall("openai", undefined, () =>
        Promise.reject(Object.assign(new Error(SENTINEL), { status: 429 })),
      ),
    ).rejects.toThrow(SENTINEL);

    const [fine, failed] = recorder.spans();

    expect(fine?.kind).toBe(2);
    expect(fine?.name).toBe("gen_ai.chat");
    expect(fine?.attributes).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.usage.input_tokens": 12,
    });
    expect(failed?.status.code).toBe(2);
    expect(failed?.attributes).toMatchObject({ "expert.error_code": "rate_limited" });
    expect((await recorder.metric("expert.dependency.calls")).map((p) => p.attributes)).toEqual([
      { dependency: "openai", outcome: "success" },
      { dependency: "openai", outcome: "failure" },
    ]);
    expect(failures()).toEqual([
      expect.objectContaining({ dependency: "openai", reason: "rate_limited" }),
    ]);
    expect(JSON.stringify([recorder.exportedSpans(), failures()])).not.toContain(SENTINEL);
  });
});
