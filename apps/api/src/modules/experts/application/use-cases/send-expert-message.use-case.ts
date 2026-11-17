import type { ConversationLock, ConversationRepository } from "../../domain/conversation-ports";
import { buildConversation, type ModelMessage } from "../../domain/expert-conversation";
import { findExpert } from "../../domain/expert-catalog";
import {
  ConversationBusyError,
  ExpertModelError,
  ExpertNotFoundError,
  ExpertUnavailableError,
} from "../../domain/expert-errors";
import type { ExpertAnswerEvent, ExpertOrchestrator, TokenUsage } from "../../domain/expert-ports";
import { EXPERT_LIMITS } from "../../domain/expert-rules";
import type { ExpertId } from "../../domain/expert";

export interface SendExpertMessageInput {
  /** The user of the session: the only owner of the conversation this call reads and writes. */
  userId: string;
  expertId: string;
  content: string;
  /** Aborted when the caller leaves (client disconnected or pressed Stop). */
  signal: AbortSignal;
}

export interface SentExpertMessage {
  /** The answer, as events. Its last event only arrives after the conversation was saved. */
  events: AsyncGenerator<ExpertAnswerEvent>;
  /**
   * Frees the "one answer at a time" lock. The stream frees it by itself when it ends; the caller
   * also calls it in a `finally`, so a stream that was never read cannot leave the lock held.
   */
  release: () => void;
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
 * Answers one message of one expert as a stream of events and keeps the conversation. The expert
 * and the model are checked up front, then the lock of (user, expert) is taken: `execute` throws
 * before any event exists, so the request can still answer with a plain error (404, 503, 409);
 * after that, failures are events, never exceptions.
 *
 * The model receives the persona, the last 20 stored messages (read here, never sent by the
 * client) and the new question, which is stored first. The answer is stored when it ends, before
 * its last event is yielded: complete, or `incomplete` with the text received when it stopped
 * half way. When no text arrived, the question is taken back, so "Try again" never leaves the
 * same question twice in the conversation.
 *
 * Policy: 30 s without a first token and 120 s in total, and one new attempt when the model
 * fails (or is silent) before the first token. After the first token there is no retry: the text
 * already sent stays and the stream ends with `failed`.
 */
export class SendExpertMessage {
  constructor(
    private readonly orchestrator: ExpertOrchestrator,
    private readonly conversations: ConversationRepository,
    private readonly lock: ConversationLock,
    private readonly timeouts: SendExpertMessageTimeouts = DEFAULT_TIMEOUTS,
  ) {}

  async execute(input: SendExpertMessageInput): Promise<SentExpertMessage> {
    const expert = findExpert(input.expertId);

    if (expert === undefined) {
      throw new ExpertNotFoundError();
    }

    if (!this.orchestrator.available) {
      throw new ExpertUnavailableError();
    }

    const release = this.lock.tryAcquire(input.userId, expert.id);

    if (release === null) {
      throw new ConversationBusyError();
    }

    try {
      const context = await this.conversations.listPage(input.userId, expert.id, {
        limit: EXPERT_LIMITS.contextMessages,
        before: null,
      });
      const question = await this.conversations.append(input.userId, expert.id, {
        role: "user",
        content: input.content,
        status: "complete",
      });

      return {
        events: this.keepAnswer(
          input.userId,
          expert.id,
          question.id,
          this.run(
            expert.id,
            buildConversation(expert, context.messages, input.content),
            input.signal,
          ),
          release,
        ),
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Stores the answer when the inner stream reaches its last event, then passes that event on, so
   * a client that reloads right after `done` already finds the answer. Always frees the lock.
   */
  private async *keepAnswer(
    userId: string,
    expertId: ExpertId,
    questionId: string,
    inner: AsyncGenerator<ExpertAnswerEvent>,
    release: () => void,
  ): AsyncGenerator<ExpertAnswerEvent> {
    let text = "";
    let settled = false;

    const settle = async (complete: boolean): Promise<boolean> => {
      settled = true;

      try {
        if (text.trim() === "") {
          await this.conversations.remove(userId, questionId);
        } else {
          await this.conversations.append(userId, expertId, {
            role: "assistant",
            content: text,
            status: complete ? "complete" : "incomplete",
          });
        }

        return true;
      } catch {
        // The reason is a closed value: the error itself never reaches a log with data in it.
        return false;
      }
    };

    try {
      for await (const event of inner) {
        if (event.type === "text") {
          text += event.text;
          yield event;
        } else {
          const stored = await settle(event.type === "done");

          yield stored || event.type === "aborted"
            ? event
            : { type: "failed", reason: "storage_error" };
        }
      }
    } finally {
      if (!settled) {
        await settle(false);
      }

      release();
    }
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
