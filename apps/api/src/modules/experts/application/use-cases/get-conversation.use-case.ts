import { decodeCursor } from "../../domain/conversation-cursor";
import type {
  ConversationRepository,
  ResolvedCitation,
  ResolvedMessage,
  ResolvedMessagePage,
  StoredMessage,
} from "../../domain/conversation-ports";
import { findExpert } from "../../domain/expert-catalog";
import { ExpertNotFoundError, InvalidCursorError } from "../../domain/expert-errors";
import type { CitationSources } from "../../domain/expert-ports";
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

/**
 * The newest messages of the conversation of the user with an expert, a page at a time. Each
 * citation is checked against the user's connections (spec 0025, R7): one whose connection was
 * deleted comes back as `removed`, without the stored name.
 */
export class GetConversation {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly sources: CitationSources,
  ) {}

  async execute(input: GetConversationInput): Promise<ResolvedMessagePage> {
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

    const page = await this.conversations.listPage(input.userId, expert.id, {
      limit: input.limit ?? EXPERT_LIMITS.pageSizeMax,
      before,
    });
    const cited = [
      ...new Set(
        page.messages.flatMap((message) =>
          (message.citations ?? []).map((citation) => citation.connectionId),
        ),
      ),
    ];
    const existing =
      cited.length === 0
        ? new Set<string>()
        : await this.sources.existingConnectionIds(input.userId, cited);

    return {
      messages: page.messages.map((message) => resolve(message, existing)),
      nextCursor: page.nextCursor,
    };
  }
}

function resolve(message: StoredMessage, existing: ReadonlySet<string>): ResolvedMessage {
  return {
    ...message,
    citations:
      message.citations?.map((citation): ResolvedCitation =>
        existing.has(citation.connectionId)
          ? { ...citation, removed: false }
          : { connectionId: citation.connectionId, removed: true },
      ) ?? null,
  };
}
