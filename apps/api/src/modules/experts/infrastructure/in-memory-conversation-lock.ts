import type { ConversationLock } from "../domain/conversation-ports";
import type { ExpertId } from "../domain/expert";

/**
 * The lock of "one answer at a time per (user, expert)", kept in memory: it only holds for a single
 * API instance, in the same spirit as the rate limit store (ADR 0005). Moving to several instances
 * means moving this port to a shared store.
 */
export class InMemoryConversationLock implements ConversationLock {
  private readonly held = new Set<string>();

  tryAcquire(userId: string, expertId: ExpertId): (() => void) | null {
    // A user id is a UUID and an expert id a slug: the separator cannot appear in either.
    const key = `${userId}|${expertId}`;

    if (this.held.has(key)) {
      return null;
    }

    this.held.add(key);

    let released = false;

    return () => {
      if (!released) {
        released = true;
        this.held.delete(key);
      }
    };
  }
}
