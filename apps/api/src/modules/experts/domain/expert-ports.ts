import type { ModelMessage } from "./expert-conversation";
import type { ExpertId } from "./expert";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** What an orchestrator produces while it runs. Failures are thrown, not emitted. */
export type OrchestratorEvent =
  | { type: "text"; text: string }
  | { type: "usage"; usage: TokenUsage };

export interface OrchestratorInput {
  expertId: ExpertId;
  messages: readonly ModelMessage[];
  /** Aborting it must stop the call to the model. */
  signal: AbortSignal;
}

/**
 * Runs one answer of an expert and streams it. The implementation (LangGraph and a chat model)
 * lives in `infrastructure`; tests plug a fake in here. It throws `ExpertModelError` on failure.
 */
export interface ExpertOrchestrator {
  /** `false` when no model is configured: the use case answers 503 without starting a stream. */
  readonly available: boolean;
  answer(input: OrchestratorInput): AsyncIterable<OrchestratorEvent>;
}

/** The events a request handler turns into the response stream. */
export type ExpertAnswerEvent =
  | { type: "text"; text: string }
  | { type: "done"; usage: TokenUsage | null }
  | { type: "failed"; reason: "provider_error" | "timeout" | "storage_error" }
  | { type: "aborted" };
