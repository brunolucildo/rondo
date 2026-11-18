import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRIEVAL_MAX_CHUNKS,
  DEFAULT_RETRIEVAL_MIN_SCORE,
  parseExpertRetrievalConfig,
} from "./expert-retrieval-config";

describe("parseExpertRetrievalConfig", () => {
  it("defaults to 6 chunks and the initial threshold", () => {
    expect(parseExpertRetrievalConfig({})).toEqual({
      maxChunks: DEFAULT_RETRIEVAL_MAX_CHUNKS,
      minScore: DEFAULT_RETRIEVAL_MIN_SCORE,
    });
    expect(DEFAULT_RETRIEVAL_MAX_CHUNKS).toBe(6);
  });

  it("reads both settings from the environment", () => {
    expect(
      parseExpertRetrievalConfig({
        EXPERT_RETRIEVAL_MAX_CHUNKS: " 4 ",
        EXPERT_RETRIEVAL_MIN_SCORE: "0.45",
      }),
    ).toEqual({ maxChunks: 4, minScore: 0.45 });
  });

  it.each([
    ["EXPERT_RETRIEVAL_MAX_CHUNKS", "0"],
    ["EXPERT_RETRIEVAL_MAX_CHUNKS", "13"],
    ["EXPERT_RETRIEVAL_MAX_CHUNKS", "2.5"],
    ["EXPERT_RETRIEVAL_MAX_CHUNKS", "abc"],
    ["EXPERT_RETRIEVAL_MIN_SCORE", "-0.1"],
    ["EXPERT_RETRIEVAL_MIN_SCORE", "1.1"],
    ["EXPERT_RETRIEVAL_MIN_SCORE", "high"],
  ])("rejects %s=%s and names the variable", (name, value) => {
    expect(() => parseExpertRetrievalConfig({ [name]: value })).toThrow(name);
  });
});
