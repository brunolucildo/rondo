import { describe, expect, it } from "vitest";
import { EXPERT_IDS } from "./expert";
import { EXPERTS, findExpert, isExpertId, PROFESSIONAL_NOTICE } from "./expert-catalog";

const NOTICE_EXPERTS = ["sports-lawyer", "physiologist", "sports-physician", "physiotherapist"];

describe("the expert catalog (R1, R6, R7)", () => {
  it("has the seven experts, in display order, with unique ids", () => {
    expect(EXPERTS.map((expert) => expert.id)).toEqual([
      "head-coach",
      "performance-analyst",
      "sports-lawyer",
      "physiologist",
      "sports-physician",
      "physiotherapist",
      "football-manager",
    ]);
    expect(EXPERTS.map((expert) => expert.id)).toEqual([...EXPERT_IDS]);
    expect(new Set(EXPERTS.map((expert) => expert.characterName)).size).toBe(EXPERTS.length);
  });

  it.each(EXPERTS.map((expert) => [expert.id, expert] as const))(
    "%s has between 3 and 6 distinct suggested questions and the persona fields",
    (_id, expert) => {
      expect(expert.suggestedQuestions.length).toBeGreaterThanOrEqual(3);
      expect(expert.suggestedQuestions.length).toBeLessThanOrEqual(6);
      expect(new Set(expert.suggestedQuestions).size).toBe(expert.suggestedQuestions.length);
      expect(expert.suggestedQuestions.every((question) => question.trim() === question)).toBe(
        true,
      );
      expect(expert.name).not.toBe("");
      expect(expert.role).not.toBe("");
      expect(expert.characterName).not.toBe("");
      expect(expert.description).not.toBe("");
      expect(expert.persona.tone).not.toBe("");
      expect(expert.persona.scope).not.toBe("");
      expect(expert.persona.limits.length).toBeGreaterThan(0);
    },
  );

  it("shows the professional notice only for the legal and health experts", () => {
    for (const expert of EXPERTS) {
      expect(expert.notice).toBe(NOTICE_EXPERTS.includes(expert.id) ? PROFESSIONAL_NOTICE : null);
      expect(expert.persona.refersToProfessional).toBe(NOTICE_EXPERTS.includes(expert.id));
    }

    expect(PROFESSIONAL_NOTICE).toBe(
      "Informational support only. It does not replace a licensed professional.",
    );
  });

  it("never names a real person (the Head Coach is a fictional character)", () => {
    const everything = JSON.stringify(EXPERTS).toLowerCase();

    for (const realName of [
      "luxemburgo",
      "vanderlei",
      "felipão",
      "tite",
      "guardiola",
      "mourinho",
    ]) {
      expect(everything).not.toContain(realName);
    }
  });

  it("finds an expert by id and refuses anything else", () => {
    expect(findExpert("physiologist")?.name).toBe("Physiologist");
    expect(findExpert("unknown")).toBeUndefined();
    expect(findExpert("__proto__")).toBeUndefined();
    expect(findExpert("")).toBeUndefined();
    expect(isExpertId("head-coach")).toBe(true);
    expect(isExpertId("Head-Coach")).toBe(false);
  });
});
