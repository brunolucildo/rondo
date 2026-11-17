import { describe, expect, it } from "vitest";
import { InMemoryConversationRepository } from "../../../../../test/support/in-memory-conversations";
import { ExpertNotFoundError, InvalidCursorError } from "../../domain/expert-errors";
import { ClearConversation } from "./clear-conversation.use-case";
import { GetConversation } from "./get-conversation.use-case";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("GetConversation (R2, R3)", () => {
  it("returns an empty list when there is no conversation", async () => {
    const useCase = new GetConversation(new InMemoryConversationRepository());

    await expect(useCase.execute({ userId: USER, expertId: "head-coach" })).resolves.toEqual({
      messages: [],
      nextCursor: null,
    });
  });

  it("returns the 50 newest of 120 messages in chronological order, and the 50 before them by cursor", async () => {
    const conversations = new InMemoryConversationRepository();
    const useCase = new GetConversation(conversations);

    conversations.seed(USER, "head-coach", 120);

    const first = await useCase.execute({ userId: USER, expertId: "head-coach" });

    expect(first.messages).toHaveLength(50);
    expect(first.messages[0]?.content).toBe("message 71");
    expect(first.messages.at(-1)?.content).toBe("message 120");
    expect(first.nextCursor).not.toBeNull();

    const second = await useCase.execute({
      userId: USER,
      expertId: "head-coach",
      before: first.nextCursor as string,
    });

    expect(second.messages[0]?.content).toBe("message 21");
    expect(second.messages.at(-1)?.content).toBe("message 70");

    const third = await useCase.execute({
      userId: USER,
      expertId: "head-coach",
      before: second.nextCursor as string,
    });

    expect(third.messages).toHaveLength(20);
    expect(third.nextCursor).toBeNull();
  });

  it("honours the limit", async () => {
    const conversations = new InMemoryConversationRepository();

    conversations.seed(USER, "head-coach", 10);

    const page = await new GetConversation(conversations).execute({
      userId: USER,
      expertId: "head-coach",
      limit: 3,
    });

    expect(page.messages.map((message) => message.content)).toEqual([
      "message 8",
      "message 9",
      "message 10",
    ]);
  });

  it("only reads the conversation of the user it was asked for", async () => {
    const conversations = new InMemoryConversationRepository();

    conversations.seed(OTHER, "head-coach", 4);

    const page = await new GetConversation(conversations).execute({
      userId: USER,
      expertId: "head-coach",
    });

    expect(page.messages).toEqual([]);
  });

  it("throws ExpertNotFoundError for an unknown expert and InvalidCursorError for a forged cursor", async () => {
    const useCase = new GetConversation(new InMemoryConversationRepository());

    await expect(useCase.execute({ userId: USER, expertId: "nobody" })).rejects.toThrow(
      ExpertNotFoundError,
    );
    await expect(
      useCase.execute({ userId: USER, expertId: "head-coach", before: "bm90LWEtdXVpZA" }),
    ).rejects.toThrow(InvalidCursorError);
  });
});

describe("ClearConversation (R7)", () => {
  it("deletes the conversation of the user and nothing else", async () => {
    const conversations = new InMemoryConversationRepository();
    const useCase = new ClearConversation(conversations);

    conversations.seed(USER, "head-coach", 4);
    conversations.seed(USER, "physiologist", 2);
    conversations.seed(OTHER, "head-coach", 3);

    await useCase.execute({ userId: USER, expertId: "head-coach" });

    expect(conversations.messages(USER, "head-coach")).toEqual([]);
    expect(conversations.messages(USER, "physiologist")).toHaveLength(2);
    expect(conversations.messages(OTHER, "head-coach")).toHaveLength(3);
  });

  it("is idempotent", async () => {
    const useCase = new ClearConversation(new InMemoryConversationRepository());

    await expect(
      useCase.execute({ userId: USER, expertId: "head-coach" }),
    ).resolves.toBeUndefined();
    await expect(
      useCase.execute({ userId: USER, expertId: "head-coach" }),
    ).resolves.toBeUndefined();
  });

  it("throws ExpertNotFoundError for an unknown expert", async () => {
    const useCase = new ClearConversation(new InMemoryConversationRepository());

    await expect(useCase.execute({ userId: USER, expertId: "nobody" })).rejects.toThrow(
      ExpertNotFoundError,
    );
  });
});
