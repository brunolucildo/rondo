import type { ExpertId } from "./expert";
import type { Citation } from "./grounding";

export type StoredMessageRole = "user" | "assistant";

/** `incomplete`: the answer stopped half way (Stop, a dropped connection or a model failure). */
export type StoredMessageStatus = "complete" | "incomplete";

export interface StoredMessage {
  id: string;
  role: StoredMessageRole;
  content: string;
  status: StoredMessageStatus;
  /**
   * The sources of an answer. `null`: no retrieval ran. `[]`: it ran and no source covers the
   * question. Never holds chunk text.
   */
  citations: Citation[] | null;
  createdAt: Date;
}

/**
 * A citation as the conversation shows it: the stored one while its connection exists, or just the
 * `connectionId` flagged `removed` once the connection was deleted (the name stays in storage but
 * never leaves the server).
 */
export type ResolvedCitation =
  | (Citation & { removed: false })
  | { connectionId: string; removed: true };

export interface ResolvedMessage extends Omit<StoredMessage, "citations"> {
  citations: ResolvedCitation[] | null;
}

export interface ResolvedMessagePage {
  /** Chronological order (oldest first). */
  messages: ResolvedMessage[];
  nextCursor: string | null;
}

export interface NewMessage {
  role: StoredMessageRole;
  content: string;
  status: StoredMessageStatus;
  /** Same meaning as `StoredMessage.citations`; absent is `null`. */
  citations?: readonly Citation[] | null;
}

export interface MessagePage {
  /** Chronological order (oldest first). */
  messages: StoredMessage[];
  /** Cursor for the page of older messages; `null` when there are none. */
  nextCursor: string | null;
}

export interface PageRequest {
  /** 1 to 50. */
  limit: number;
  /** A message id taken from a valid cursor: only older messages are returned. */
  before: string | null;
}

/**
 * The persisted conversations, one per (user, expert). Every method takes the user id of the
 * session: nothing here can reach a conversation of another user.
 */
export interface ConversationRepository {
  /** The newest messages first (a page), returned in chronological order. */
  listPage(userId: string, expertId: ExpertId, request: PageRequest): Promise<MessagePage>;
  /**
   * Adds a message (creating the conversation on the first one) and drops the oldest beyond the
   * retention limit, atomically.
   */
  append(
    userId: string,
    expertId: ExpertId,
    message: NewMessage,
  ): Promise<{ id: string; createdAt: Date }>;
  /** Removes one message of the user (a no-op for an unknown id). */
  remove(userId: string, messageId: string): Promise<void>;
  /** Deletes the conversation and its messages. Idempotent. */
  clear(userId: string, expertId: ExpertId): Promise<void>;
}

/**
 * One answer at a time per (user, expert). `tryAcquire` returns the release function, or `null`
 * when an answer is already running. Calling the release function twice is harmless.
 */
export interface ConversationLock {
  tryAcquire(userId: string, expertId: ExpertId): (() => void) | null;
}
