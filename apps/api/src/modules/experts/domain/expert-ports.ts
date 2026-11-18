import type { ModelMessage } from "./expert-conversation";
import type { ExpertId } from "./expert";
import type { Citation, RetrievedChunk } from "./grounding";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** What an orchestrator produces while it runs. Failures are thrown, not emitted. */
export type OrchestratorEvent =
  | { type: "text"; text: string }
  | { type: "usage"; usage: TokenUsage }
  /**
   * The sources of the answer, once, as soon as the retrieval ends (before the first token).
   * Empty means no connected source covers the question. Not emitted when no retrieval ran.
   */
  | { type: "citations"; citations: Citation[] };

/** What to look for in the knowledge base of the user for one question. */
export interface RetrievalRequest {
  /** The user of the session: the retrieval only touches this user's data. */
  userId: string;
  question: string;
  /** Restricts the search to these connections; `null` searches the whole base of the user. */
  connectionIds: readonly string[] | null;
}

export interface OrchestratorInput {
  expertId: ExpertId;
  messages: readonly ModelMessage[];
  /** What to retrieve before answering; absent or `null` means no retrieval (no connections). */
  retrieval?: RetrievalRequest | null;
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

/**
 * Finds the chunks of the user's connected documents that are relevant to a question (embeds it
 * and searches the index). The implementation lives in `infrastructure`, over the `knowledge`
 * ports. It throws `ExpertKnowledgeUnavailableError` when the embeddings or the index fail, and
 * returns `[]` when nothing passes the similarity threshold.
 */
export interface KnowledgeRetriever {
  retrieve(request: RetrievalRequest, signal: AbortSignal): Promise<RetrievedChunk[]>;
}

/**
 * What the use case needs to know about the user's connections before it retrieves. Implemented
 * over the `connections` module; every method is scoped to the user of the session.
 */
export interface ConnectionSources {
  /**
   * Checks that every id is a connection of the user and is `ready`. Throws
   * `ConnectionNotFoundError` (unknown or someone else's) or `ConnectionNotReadyError`.
   */
  assertAttachable(userId: string, connectionIds: readonly string[]): Promise<void>;
  /** True when the user has at least one `ready` connection (otherwise nothing is retrieved). */
  hasReadyConnection(userId: string): Promise<boolean>;
}

/**
 * Which cited connections still exist (spec 0025). A citation whose connection was deleted is
 * shown as "Source removed", without its stored name. Scoped to the user of the session.
 */
export interface CitationSources {
  /** The ids, among `connectionIds`, that are still connections of the user. */
  existingConnectionIds(
    userId: string,
    connectionIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
}

/** The events a request handler turns into the response stream. */
export type ExpertAnswerEvent =
  | { type: "text"; text: string }
  /** The sources of the answer; the use case sends it right before `done`. */
  | { type: "citations"; citations: Citation[] }
  | { type: "done"; usage: TokenUsage | null }
  | {
      type: "failed";
      reason: "provider_error" | "timeout" | "storage_error" | "knowledge_unavailable";
    }
  | { type: "aborted" };
