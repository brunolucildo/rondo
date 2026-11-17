import { describe, expect, it } from "vitest";
import { EXPERTS } from "../../../apps/api/src/modules/experts/domain/expert-catalog";
import {
  AVATAR_CHARACTERS,
  buildPrompt,
  findForbiddenTerms,
  FORBIDDEN_TERMS,
} from "./characters.ts";

describe("character sheets", () => {
  it("cover exactly the experts of the API catalog, with the same fictional names", () => {
    expect(AVATAR_CHARACTERS.map(({ id, characterName }) => ({ id, characterName }))).toEqual(
      EXPERTS.map(({ id, characterName }) => ({ id, characterName })),
    );
  });

  it("have unique ids that are safe as file names", () => {
    const ids = AVATAR_CHARACTERS.map((character) => character.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z][a-z-]*$/.test(id))).toBe(true);
  });
});

describe("prompts", () => {
  for (const character of AVATAR_CHARACTERS) {
    describe(character.id, () => {
      const prompt = buildPrompt(character);

      it("ask for pixel art, 8-bit and no text", () => {
        expect(prompt).toMatch(/pixel art/i);
        expect(prompt).toMatch(/8-bit/i);
        expect(prompt).toMatch(/no text/i);
      });

      it("mention no real person, club or brand", () => {
        expect(findForbiddenTerms(prompt)).toEqual([]);
      });

      it("never carry the character name, which the model could paint as text", () => {
        for (const part of character.characterName.split(" ")) {
          expect(prompt).not.toContain(part);
        }
      });
    });
  }

  it("are different from one another", () => {
    const prompts = AVATAR_CHARACTERS.map(buildPrompt);

    expect(new Set(prompts).size).toBe(prompts.length);
  });
});

describe("findForbiddenTerms", () => {
  it("finds whole words, ignoring case and accents", () => {
    expect(findForbiddenTerms("A portrait of PELÉ in an Adidas shirt")).toEqual(["pele", "adidas"]);
  });

  it("does not match inside other words", () => {
    expect(findForbiddenTerms("a title, a mariner and a peleton")).toEqual([]);
  });

  it("has a non-empty list", () => {
    expect(FORBIDDEN_TERMS.length).toBeGreaterThan(20);
  });
});
