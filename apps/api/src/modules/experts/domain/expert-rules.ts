/** Connections the user may attach to one message (`connectionIds`). */
export const MAX_ATTACHED_CONNECTIONS = 10;

export const EXPERT_LIMITS = {
  /** Characters of one message from the user. */
  contentMax: 4000,
  /** Stored messages the model receives as context (plus the new question). */
  contextMessages: 20,
  /** Messages a conversation keeps; writing one more removes the oldest, in the same transaction. */
  conversationMessagesMax: 200,
  /** Messages of one page of `GET /experts/:expertId/conversation`. */
  pageSizeMax: 50,
  /** Seconds a request may wait for the first token before one retry. */
  firstTokenTimeoutMs: 30_000,
  /** Total time one answer may take. */
  totalTimeoutMs: 120_000,
} as const;
