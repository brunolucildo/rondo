import type { ConversationRepository } from "../../domain/conversation-ports";
import { findExpert } from "../../domain/expert-catalog";
import { ExpertNotFoundError } from "../../domain/expert-errors";

export interface ClearConversationInput {
  /** The user of the session: only their own conversation can be cleared. */
  userId: string;
  expertId: string;
}

/** Deletes the conversation of the user with an expert. Idempotent: no conversation is fine. */
export class ClearConversation {
  constructor(private readonly conversations: ConversationRepository) {}

  async execute(input: ClearConversationInput): Promise<void> {
    const expert = findExpert(input.expertId);

    if (expert === undefined) {
      throw new ExpertNotFoundError();
    }

    await this.conversations.clear(input.userId, expert.id);
  }
}
