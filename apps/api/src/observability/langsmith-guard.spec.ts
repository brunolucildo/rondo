import { beforeEach, describe, expect, it, vi } from "vitest";
import { disableLangSmithTracing } from "./langsmith-guard";
import { baseLogger } from "./logger";

const KEY = "lsv2_SENTINEL_secret_key_4410";

describe("LangSmith tracing guard (spec 0029, R8)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(baseLogger, "warn").mockImplementation(() => undefined);
  });

  it("turns every tracing switch off, drops the credentials and logs the variable names only", () => {
    const env: Record<string, string | undefined> = {
      LANGSMITH_TRACING: "true",
      LANGCHAIN_TRACING_V2: "TRUE",
      LANGSMITH_API_KEY: KEY,
      LANGCHAIN_API_KEY: KEY,
      LANGSMITH_ENDPOINT: "http://127.0.0.1:1",
      OPENAI_API_KEY: "sk-keep-me",
    };

    expect(disableLangSmithTracing(env)).toEqual(["LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2"]);
    expect(env).toEqual({
      LANGSMITH_TRACING: "false",
      LANGSMITH_TRACING_V2: "false",
      LANGCHAIN_TRACING: "false",
      LANGCHAIN_TRACING_V2: "false",
      OPENAI_API_KEY: "sk-keep-me",
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toEqual({
      event: "langsmith_tracing_disabled",
      variables: ["LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2"],
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(KEY);
  });

  it("stays silent when the tracing was already off, and keeps it off for a later .env load", () => {
    const env: Record<string, string | undefined> = { LANGSMITH_TRACING: "false" };

    expect(disableLangSmithTracing(env)).toEqual([]);
    expect(disableLangSmithTracing({})).toEqual([]);
    expect(env.LANGCHAIN_TRACING_V2).toBe("false");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("is idempotent: a second call finds nothing to disable", () => {
    const env: Record<string, string | undefined> = { LANGCHAIN_TRACING: "1" };

    expect(disableLangSmithTracing(env)).toEqual(["LANGCHAIN_TRACING"]);
    expect(disableLangSmithTracing(env)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
