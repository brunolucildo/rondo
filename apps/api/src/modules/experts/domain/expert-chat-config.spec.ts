import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_MODEL, parseExpertChatConfig } from "./expert-chat-config";

describe("parseExpertChatConfig (R8, R10)", () => {
  it("uses the scripted fake in test, even with a key, so tests never reach OpenAI", () => {
    expect(parseExpertChatConfig({ OPENAI_API_KEY: "sk-test" }, "test")).toEqual({
      provider: "fake",
    });
    expect(parseExpertChatConfig({}, "test")).toEqual({ provider: "fake" });
  });

  it("is unavailable without a key (the API still boots)", () => {
    expect(parseExpertChatConfig({}, "dev")).toEqual({ provider: "unavailable" });
    expect(parseExpertChatConfig({ OPENAI_API_KEY: "   " }, "production")).toEqual({
      provider: "unavailable",
    });
  });

  it("uses OpenAI with gpt-4o-mini by default when the key is set", () => {
    expect(parseExpertChatConfig({ OPENAI_API_KEY: " sk-dev " }, "dev")).toEqual({
      provider: "openai",
      apiKey: "sk-dev",
      model: DEFAULT_CHAT_MODEL,
    });
    expect(DEFAULT_CHAT_MODEL).toBe("gpt-4o-mini");
  });

  it("lets OPENAI_CHAT_MODEL choose the model", () => {
    expect(
      parseExpertChatConfig({ OPENAI_API_KEY: "sk", OPENAI_CHAT_MODEL: "gpt-4o" }, "production"),
    ).toMatchObject({ provider: "openai", model: "gpt-4o" });
  });

  it("never selects the fake in production", () => {
    expect(parseExpertChatConfig({ OPENAI_API_KEY: "sk" }, "production").provider).toBe("openai");
    expect(parseExpertChatConfig({}, "production").provider).toBe("unavailable");
  });
});
