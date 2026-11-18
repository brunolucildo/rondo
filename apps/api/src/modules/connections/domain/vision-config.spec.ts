import { describe, expect, it } from "vitest";
import { DEFAULT_VISION_MODEL, parseVisionConfig } from "./vision-config";

describe("parseVisionConfig", () => {
  it("uses the scripted fake for NODE_ENV=test, even with a key (never the network)", () => {
    expect(parseVisionConfig({ OPENAI_API_KEY: "sk-test" }, "test")).toEqual({ provider: "fake" });
  });

  it("is unavailable without a key, whatever the environment", () => {
    expect(parseVisionConfig({}, "dev")).toEqual({ provider: "unavailable" });
    expect(parseVisionConfig({ OPENAI_API_KEY: "  " }, "production")).toEqual({
      provider: "unavailable",
    });
  });

  it("uses OpenAI with gpt-4o-mini by default and the model of OPENAI_VISION_MODEL when set", () => {
    expect(parseVisionConfig({ OPENAI_API_KEY: "sk-1" }, "dev")).toEqual({
      provider: "openai",
      apiKey: "sk-1",
      model: DEFAULT_VISION_MODEL,
    });
    expect(DEFAULT_VISION_MODEL).toBe("gpt-4o-mini");
    expect(
      parseVisionConfig({ OPENAI_API_KEY: "sk-1", OPENAI_VISION_MODEL: " gpt-4o " }, "production"),
    ).toMatchObject({ model: "gpt-4o" });
  });
});
