import { baseLogger } from "./logger";

/**
 * LangChain.js (and the `langsmith` client under it) sends every run of a model or a graph to
 * LangSmith, a third party, as soon as one of these variables says so. The runs carry prompts and
 * retrieved text (health data of athletes), so the product keeps the tracing off and observes the
 * agents by OpenTelemetry instead (spec `0029`, R8).
 */
const TRACING_SWITCHES = [
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
] as const;

/** Credentials and destinations of LangSmith: dropped, so nothing can reach it even by mistake. */
const LANGSMITH_SETTINGS = [
  "LANGSMITH_API_KEY",
  "LANGCHAIN_API_KEY",
  "LANGSMITH_ENDPOINT",
  "LANGCHAIN_ENDPOINT",
  "LANGSMITH_PROJECT",
  "LANGCHAIN_PROJECT",
  "LANGSMITH_WORKSPACE_ID",
] as const;

const OFF_VALUES = new Set(["", "false", "0", "no", "off"]);

type Environment = Record<string, string | undefined>;

/**
 * Turns the LangSmith tracing off for this process and returns the names of the switches that were
 * on (empty when nothing had to change). Run it before any model or graph is created. When a
 * switch was on it logs `langsmith_tracing_disabled` with the variable names only: never a value,
 * never a key.
 */
export function disableLangSmithTracing(env: Environment = process.env): string[] {
  const active = TRACING_SWITCHES.filter(
    (name) => !OFF_VALUES.has((env[name] ?? "").toLowerCase()),
  );

  // Also the unset ones: a later load of the `.env` file never overrides a variable already set.
  for (const name of TRACING_SWITCHES) {
    env[name] = "false";
  }

  for (const name of LANGSMITH_SETTINGS) {
    delete env[name];
  }

  if (active.length > 0) {
    baseLogger.warn(
      { event: "langsmith_tracing_disabled", variables: active },
      "langsmith_tracing_disabled",
    );
  }

  return [...active];
}
