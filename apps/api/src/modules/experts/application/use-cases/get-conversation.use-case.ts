import { decodeCursor } from "../../domain/conversation-cursor";
import type { ConversationRepository, MessagePage } from "../../domain/conversation-ports";
import { findExpert } from "../../domain/expert-catalog";
import { ExpertNotFoundError, InvalidCursorError } from "../../domain/expert-errors";
import { EXPERT_LIMITS } from "../../domain/expert-rules";

export interface GetConversationInput {
  /** The user of the session. */
  userId: string;
  expertId: string;
  /** 1 to 50; the page size when absent. */
  limit?: number;
  /** An opaque cursor from a previous `nextCursor`. */
  before?: string;
}

/** The newest messages of the conversation of the user with an expert, a page at a time. */
export class GetConversation {
  constructor(private readonly conversations: ConversationRepository) {}

  async execute(input: GetConversationInput): Promise<MessagePage> {
    const expert = findExpert(input.expertId);

    if (expert === undefined) {
      throw new ExpertNotFoundError();
    }

    let before: string | null = null;

    if (input.before !== undefined) {
      before = decodeCursor(input.before);

      if (before === null) {
        throw new InvalidCursorError();
      }
    }

    return this.conversations.listPage(input.userId, expert.id, {
      limit: input.limit ?? EXPERT_LIMITS.pageSizeMax,
      before,
    });
  }
}
