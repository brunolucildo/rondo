import { describe, expect, it } from "vitest";
import { InMemoryConversationLock } from "./in-memory-conversation-lock";

describe("InMemoryConversationLock", () => {
  it("hands the lock to one holder per (user, expert)", () => {
    const lock = new InMemoryConversationLock();

    expect(lock.tryAcquire("user-1", "head-coach")).not.toBeNull();
    expect(lock.tryAcquire("user-1", "head-coach")).toBeNull();
  });

  it("does not block another expert or another user", () => {
    const lock = new InMemoryConversationLock();

    lock.tryAcquire("user-1", "head-coach");

    expect(lock.tryAcquire("user-1", "physiologist")).not.toBeNull();
    expect(lock.tryAcquire("user-2", "head-coach")).not.toBeNull();
  });

  it("is free again after the release", () => {
    const lock = new InMemoryConversationLock();

    lock.tryAcquire("user-1", "head-coach")?.();

    expect(lock.tryAcquire("user-1", "head-coach")).not.toBeNull();
  });

  it("releases only once: a late second release never frees the next holder's lock", () => {
    const lock = new InMemoryConversationLock();
    const first = lock.tryAcquire("user-1", "head-coach");

    first?.();

    const second = lock.tryAcquire("user-1", "head-coach");

    first?.();

    expect(second).not.toBeNull();
    expect(lock.tryAcquire("user-1", "head-coach")).toBeNull();
  });
});
