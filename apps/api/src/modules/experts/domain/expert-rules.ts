export const EXPERT_LIMITS = {
  /** Characters of one message, from the user or in the history. */
  contentMax: 4000,
  /** Previous messages the client may send as context. */
  historyMax: 20,
  /** Seconds a request may wait for the first token before one retry. */
  firstTokenTimeoutMs: 30_000,
  /** Total time one answer may take. */
  totalTimeoutMs: 120_000,
} as const;

export const EXPERT_MESSAGE_ROLES = ["user", "assistant"] as const;
