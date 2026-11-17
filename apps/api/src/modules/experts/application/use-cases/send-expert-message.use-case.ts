import {
  buildConversation,
  type ChatTurn,
  type ModelMessage,
} from "../../domain/expert-conversation";
import { findExpert } from "../../domain/expert-catalog";
import {
  ExpertModelError,
  ExpertNotFoundError,
  ExpertUnavailableError,
} from "../../domain/expert-errors";
import type { ExpertAnswerEvent, ExpertOrchestrator, TokenUsage } from "../../domain/expert-ports";
import { EXPERT_LIMITS } from "../../domain/expert-rules";
import type { ExpertId } from "../../domain/expert";

export interface SendExpertMessageInput {
  expertId: string;
  content: string;
  history: readonly ChatTurn[];
  /** Aborted when the caller leaves (client disconnected or pressed Stop). */
  signal: AbortSignal;
}

export interface SendExpertMessageTimeouts {
  firstTokenMs: number;
  totalMs: number;
}

const DEFAULT_TIMEOUTS: SendExpertMessageTimeouts = {
  firstTokenMs: EXPERT_LIMITS.firstTokenTimeoutMs,
  totalMs: EXPERT_LIMITS.totalTimeoutMs,
};

/** One try plus one retry, and the retry only happens before the first token. */
const MAX_ATTEMPTS = 2;

const STOPPED = Symbol("stopped");

type AttemptResult =
  | { kind: "completed"; usage: TokenUsage | null }
  | { kind: "stopped"; emitted: boolean }
  | { kind: "failed"; retryable: boolean; emitted: boolean };

/**
 * Answers one message of one expert as a stream of events. The expert and the model are checked
 * up front (`execute` throws before any event exists, so the request can still answer with a
 * plain error); after that, failures are events, never exceptions.
 *
 * Policy: 30 s without a first token and 120 s in total, and one new attempt when the model
 * fails (or is silent) before the first token. After the first token there is no retry: the text
 * already sent stays and the stream ends with `failed`.
 */
export class SendExpertMessage {
  constructor(
    private readonly orchestrator: ExpertOrchestrator,
    private readonly timeouts: SendExpertMessageTimeouts = DEFAULT_TIMEOUTS,
  ) {}

  execute(input: SendExpertMessageInput): AsyncGenerator<ExpertAnswerEvent> {
    const expert = findExpert(input.expertId);

    if (expert === undefined) {
      throw new ExpertNotFoundError();
    }

    if (!this.orchestrator.available) {
      throw new ExpertUnavailableError();
    }

    return this.run(
      expert.id,
      buildConversation(expert, input.history, input.content),
      input.signal,
    );
  }

  private async *run(
    expertId: ExpertId,
    messages: readonly ModelMessage[],
    caller: AbortSignal,
  ): AsyncGenerator<ExpertAnswerEvent> {
    if (caller.aborted) {
      yield { type: "aborted" };
      return;
    }

    const total = new AbortController();
    // An object, not a `let`: the callbacks below write it and flow analysis must not narrow it.
    const state: { stop: "client" | "timeout" | null } = { stop: null };
    const stopWith = (why: "client" | "timeout") => {
      state.stop ??= why;
      total.abort();
    };
    const onCallerAbort = () => stopWith("client");
    const totalTimer = setTimeout(() => stopWith("timeout"), this.timeouts.totalMs);

    caller.addEventListener("abort", onCallerAbort, { once: true });

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const result = yield* this.attempt(expertId, messages, total.signal);

        if (result.kind === "completed") {
          yield { type: "done", usage: result.usage };
          return;
        }

        if (state.stop === "client") {
          yield { type: "aborted" };
          return;
        }

        if (state.stop === "timeout") {
          yield { type: "failed", reason: "timeout" };
          return;
        }

        const retryable = result.kind === "stopped" || result.retryable;

        if (!result.emitted && retryable && attempt < MAX_ATTEMPTS) {
          continue;
        }

        yield { type: "failed", reason: result.kind === "stopped" ? "timeout" : "provider_error" };
        return;
      }
    } finally {
      clearTimeout(totalTimer);
      caller.removeEventListener("abort", onCallerAbort);
    }
  }

  private async *attempt(
    expertId: ExpertId,
    messages: readonly ModelMessage[],
    total: AbortSignal,
  ): AsyncGenerator<ExpertAnswerEvent, AttemptResult> {
    const attempt = new AbortController();
    const abortAttempt = () => attempt.abort();
    const firstTokenTimer = setTimeout(abortAttempt, this.timeouts.firstTokenMs);
    const stopped = new Promise<typeof STOPPED>((resolve) => {
      attempt.signal.addEventListener("abort", () => resolve(STOPPED), { once: true });
    });
    let emitted = false;
    let usage: TokenUsage | null = null;

    total.addEventListener("abort", abortAttempt, { once: true });

    if (total.aborted) {
      abortAttempt();
    }

    const iterator = this.orchestrator
      .answer({ expertId, messages, signal: attempt.signal })
      [Symbol.asyncIterator]();

    try {
      while (true) {
        const next = iterator.next();

        // If the stop wins the race, the pending `next` may still reject later: nobody awaits it.
        next.catch(() => undefined);

        const step = await Promise.race([next, stopped]);

        if (step === STOPPED) {
          return { kind: "stopped", emitted };
        }

        if (step.done === true) {
          return { kind: "completed", usage };
        }

        if (step.value.type === "usage") {
          usage = step.value.usage;
          continue;
        }

        if (!emitted) {
          emitted = true;
          clearTimeout(firstTokenTimer);
        }

        yield { type: "text", text: step.value.text };
      }
    } catch (error) {
      if (attempt.signal.aborted) {
        return { kind: "stopped", emitted };
      }

      return {
        kind: "failed",
        retryable: error instanceof ExpertModelError ? error.retryable : true,
        emitted,
      };
    } finally {
      clearTimeout(firstTokenTimer);
      total.removeEventListener("abort", abortAttempt);
      // Releases the model call when the stream was stopped; a stuck iterator must not block us.
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  }
}
