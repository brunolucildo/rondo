import { randomUUID } from "node:crypto";
import { encodeCursor } from "../../src/modules/experts/domain/conversation-cursor";
import type {
  ConversationRepository,
  MessagePage,
  NewMessage,
  PageRequest,
  StoredMessage,
} from "../../src/modules/experts/domain/conversation-ports";
import type { ExpertId } from "../../src/modules/experts/domain/expert";
import { EXPERT_LIMITS } from "../../src/modules/experts/domain/expert-rules";

/**
 * A `ConversationRepository` kept in memory for the unit tests: same rules as the Postgres one
 * (per user and expert, newest page first, cursor by message id, retention limit), no database.
 */
export class InMemoryConversationRepository implements ConversationRepository {
  private readonly conversations = new Map<string, StoredMessage[]>();
  private tick = 0;
  /** The next call fails once with this error (to test what happens when storage is down). */
  failNext: { method: "listPage" | "append" | "remove" | "clear"; error: Error } | null = null;
  /** Every call to `append` and `remove`, in order. */
  readonly writes: Array<{
    kind: "append" | "remove";
    role?: string;
    content?: string;
    citations?: NewMessage["citations"];
  }> = [];

  private key(userId: string, expertId: ExpertId): string {
    return `${userId}|${expertId}`;
  }

  private maybeFail(method: "listPage" | "append" | "remove" | "clear"): void {
    if (this.failNext?.method === method) {
      const { error } = this.failNext;

      this.failNext = null;
      throw error;
    }
  }

  /** Test helper: the messages of a conversation, oldest first. */
  messages(userId: string, expertId: ExpertId): readonly StoredMessage[] {
    return this.conversations.get(this.key(userId, expertId)) ?? [];
  }

  /** Test helper: puts `count` alternating messages in a conversation (`message 1`, `message 2`...). */
  seed(userId: string, expertId: ExpertId, count: number): void {
    for (let index = 1; index <= count; index += 1) {
      this.push(userId, expertId, {
        role: index % 2 === 1 ? "user" : "assistant",
        content: `message ${index}`,
        status: "complete",
      });
    }
  }

  private push(userId: string, expertId: ExpertId, message: NewMessage): StoredMessage {
    const { citations, ...rest } = message;
    const stored: StoredMessage = {
      id: randomUUID(),
      ...rest,
      citations: citations === undefined || citations === null ? null : [...citations],
      createdAt: new Date(Date.UTC(2026, 10, 17, 12, 0, 0) + (this.tick += 1) * 1000),
    };
    const key = this.key(userId, expertId);
    const list = [...(this.conversations.get(key) ?? []), stored];

    this.conversations.set(key, list.slice(-EXPERT_LIMITS.conversationMessagesMax));

    return stored;
  }

  listPage(userId: string, expertId: ExpertId, request: PageRequest): Promise<MessagePage> {
    try {
      this.maybeFail("listPage");
    } catch (error) {
      return Promise.reject(error as Error);
    }

    const all = this.messages(userId, expertId);
    const end =
      request.before === null
        ? all.length
        : all.findIndex((message) => message.id === request.before);

    if (end < 0) {
      return Promise.resolve({ messages: [], nextCursor: null });
    }

    const start = Math.max(0, end - request.limit);
    const messages = all.slice(start, end);
    const oldest = messages[0];

    return Promise.resolve({
      messages,
      nextCursor: start > 0 && oldest !== undefined ? encodeCursor(oldest.id) : null,
    });
  }

  append(
    userId: string,
    expertId: ExpertId,
    message: NewMessage,
  ): Promise<{ id: string; createdAt: Date }> {
    try {
      this.maybeFail("append");
    } catch (error) {
      return Promise.reject(error as Error);
    }

    this.writes.push({
      kind: "append",
      role: message.role,
      content: message.content,
      citations: message.citations,
    });

    const stored = this.push(userId, expertId, message);

    return Promise.resolve({ id: stored.id, createdAt: stored.createdAt });
  }

  remove(userId: string, messageId: string): Promise<void> {
    try {
      this.maybeFail("remove");
    } catch (error) {
      return Promise.reject(error as Error);
    }

    this.writes.push({ kind: "remove" });

    for (const [key, list] of this.conversations) {
      if (key.startsWith(`${userId}|`)) {
        this.conversations.set(
          key,
          list.filter((message) => message.id !== messageId),
        );
      }
    }

    return Promise.resolve();
  }

  clear(userId: string, expertId: ExpertId): Promise<void> {
    try {
      this.maybeFail("clear");
    } catch (error) {
      return Promise.reject(error as Error);
    }

    this.conversations.delete(this.key(userId, expertId));

    return Promise.resolve();
  }
}
