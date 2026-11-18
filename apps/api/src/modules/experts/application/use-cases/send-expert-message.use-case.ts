import type { ConversationLock, ConversationRepository } from "../../domain/conversation-ports";
import { buildConversation, type ModelMessage } from "../../domain/expert-conversation";
import { findExpert } from "../../domain/expert-catalog";
import {
  ConversationBusyError,
  ExpertKnowledgeUnavailableError,
  ExpertModelError,
  ExpertNotFoundError,
  ExpertUnavailableError,
} from "../../domain/expert-errors";
import type {
  ConnectionSources,
  ExpertAnswerEvent,
  ExpertOrchestrator,
  RetrievalRequest,
  TokenUsage,
} from "../../domain/expert-ports";
import { EXPERT_LIMITS } from "../../domain/expert-rules";
import type { ExpertId } from "../../domain/expert";
import type { Citation } from "../../domain/grounding";

export interface SendExpertMessageInput {
  /** The user of the session: the only owner of the conversation this call reads and writes. */
  userId: string;
  expertId: string;
  content: string;
  /**
   * Connections the user attached to this message (already validated as a list of UUIDs, at most
   * 10). The search is limited to them; absent or empty searches the whole base of the user.
   */
  connectionIds?: readonly string[];
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

/** The sources of a user without connections: nothing is ready, so nothing is retrieved. */
const NO_SOURCES: ConnectionSources = {
  assertAttachable: () => Promise.resolve(),
  hasReadyConnection: () => Promise.resolve(false),
};

/** One try plus one retry, and the retry only happens before the first token. */
const MAX_ATTEMPTS = 2;

const STOPPED = Symbol("stopped");

type AttemptResult =
  | { kind: "completed"; usage: TokenUsage | null }
  | { kind: "stopped"; emitted: boolean }
  | { kind: "failed"; retryable: boolean; emitted: boolean; knowledge: boolean };

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
 * Retrieval (spec 0024): when the message carries `connectionIds` they are checked first (they
 * must be the user's and `ready`: `ConnectionNotFoundError` or `ConnectionNotReadyError` before any
 * event exists) and the search is limited to them; otherwise the whole base is searched, but only
 * when the user has a `ready` connection (without one nothing is retrieved and the answer goes as
 * before). The orchestrator reports the citations built from the retrieved chunks; they are stored
 * with the answer (also a partial one) and passed on right before `done`. When the retrieval fails
 * the stream ends with `knowledge_unavailable` and the question stays stored (the next send of
 * the same text reuses it instead of duplicating it).
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
    private readonly sources: ConnectionSources = NO_SOURCES,
  ) {}

  async execute(input: SendExpertMessageInput): Promise<SentExpertMessage> {
    const expert = findExpert(input.expertId);

    if (expert === undefined) {
      throw new ExpertNotFoundError();
    }

    if (!this.orchestrator.available) {
      throw new ExpertUnavailableError();
    }

    const retrieval = await this.planRetrieval(input);
    const release = this.lock.tryAcquire(input.userId, expert.id);

    if (release === null) {
      throw new ConversationBusyError();
    }

    try {
      const context = await this.conversations.listPage(input.userId, expert.id, {
        limit: EXPERT_LIMITS.contextMessages,
        before: null,
      });
      // A question left without an answer by a failed retrieval is asked again with the same
      // text ("Try again"): that stored question is reused, not stored a second time.
      const pending = context.messages.at(-1);
      const reusable = pending?.role === "user" && pending.content === input.content;
      const history = reusable ? context.messages.slice(0, -1) : context.messages;
      const questionId = reusable
        ? pending.id
        : (
            await this.conversations.append(input.userId, expert.id, {
              role: "user",
              content: input.content,
              status: "complete",
            })
          ).id;

      return {
        events: this.keepAnswer(
          input.userId,
          expert.id,
          questionId,
          this.run(
            expert.id,
            buildConversation(expert, history, input.content),
            retrieval,
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
   * Decides what to retrieve, before anything is stored or streamed. `null`: nothing (the user
   * has no ready connection).
   */
  private async planRetrieval(input: SendExpertMessageInput): Promise<RetrievalRequest | null> {
    const connectionIds = [...new Set(input.connectionIds ?? [])];

    if (connectionIds.length > 0) {
      await this.sources.assertAttachable(input.userId, connectionIds);

      return { userId: input.userId, question: input.content, connectionIds };
    }

    return (await this.sources.hasReadyConnection(input.userId))
      ? { userId: input.userId, question: input.content, connectionIds: null }
      : null;
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
    /** `null`: no retrieval ran; the last one reported wins (a retry runs it again). */
    let citations: Citation[] | null = null;

    const settle = async (complete: boolean, keepQuestion: boolean): Promise<boolean> => {
      settled = true;

      try {
        if (text.trim() === "") {
          if (!keepQuestion) {
            await this.conversations.remove(userId, questionId);
          }
        } else {
          await this.conversations.append(userId, expertId, {
            role: "assistant",
            content: text,
            status: complete ? "complete" : "incomplete",
            citations,
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
        } else if (event.type === "citations") {
          citations = event.citations;
        } else {
          // The question of a failed retrieval stays: the user asked it and the answer was
          // never started (BUSINESS.md: the user's message is never lost).
          const stored = await settle(
            event.type === "done",
            event.type === "failed" && event.reason === "knowledge_unavailable",
          );

          if (event.type === "done" && stored && citations !== null) {
            yield { type: "citations", citations };
          }

          yield stored || event.type === "aborted"
            ? event
            : { type: "failed", reason: "storage_error" };
        }
      }
    } finally {
      if (!settled) {
        await settle(false, false);
      }

      release();
    }
  }

  private async *run(
    expertId: ExpertId,
    messages: readonly ModelMessage[],
    retrieval: RetrievalRequest | null,
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
        const result = yield* this.attempt(expertId, messages, retrieval, total.signal);

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

        if (result.kind === "failed" && result.knowledge) {
          // The embeddings and the index already retry on their own: no new attempt here.
          yield { type: "failed", reason: "knowledge_unavailable" };
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
    retrieval: RetrievalRequest | null,
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
      .answer({ expertId, messages, retrieval, signal: attempt.signal })
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

        if (step.value.type === "citations") {
          // Not a token: the first-token clock and the retry rule keep waiting for text.
          yield { type: "citations", citations: step.value.citations };
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
        knowledge: error instanceof ExpertKnowledgeUnavailableError,
      };
    } finally {
      clearTimeout(firstTokenTimer);
      total.removeEventListener("abort", abortAttempt);
      // Releases the model call when the stream was stopped; a stuck iterator must not block us.
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  }
}
