import type { ExpertId } from "./expert";

export type StoredMessageRole = "user" | "assistant";

/** `incomplete`: the answer stopped half way (Stop, a dropped connection or a model failure). */
export type StoredMessageStatus = "complete" | "incomplete";

export interface StoredMessage {
  id: string;
  role: StoredMessageRole;
  content: string;
  status: StoredMessageStatus;
  createdAt: Date;
}

export interface NewMessage {
  role: StoredMessageRole;
  content: string;
  status: StoredMessageStatus;
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
