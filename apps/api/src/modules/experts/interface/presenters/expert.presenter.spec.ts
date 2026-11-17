import { describe, expect, it } from "vitest";
import { EXPERTS } from "../../domain/expert-catalog";
import { buildSystemPrompt } from "../../domain/expert-conversation";
import { presentExpert } from "./expert.presenter";

describe("presentExpert (R1)", () => {
  it("exposes only the public fields", () => {
    const [first] = EXPERTS;

    expect(first).toBeDefined();
    expect(Object.keys(presentExpert(EXPERTS[0]!)).sort()).toEqual([
      "characterName",
      "description",
      "id",
      "name",
      "notice",
      "role",
      "suggestedQuestions",
    ]);
  });

  it("carries no avatar: the app resolves the picture by id (spec 0021)", () => {
    for (const expert of EXPERTS) {
      expect(presentExpert(expert)).not.toHaveProperty("avatar");
    }
  });

  it("never leaks the persona, the limits or the system prompt", () => {
    for (const expert of EXPERTS) {
      const json = JSON.stringify(presentExpert(expert));

      expect(json).not.toContain(expert.persona.tone);
      expect(json).not.toContain(expert.persona.scope);
      expect(json).not.toContain(buildSystemPrompt(expert));
      expect(json).not.toMatch(/persona|prompt|limits|style/i);
    }
  });
});
