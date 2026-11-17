import { describe, expect, it } from "vitest";
import { KnowledgeIndexUnavailableError } from "../domain/knowledge-errors";
import { isTenantNotFound, toKnowledgeIndexError } from "./weaviate-errors";

const named = (name: string, message: string): Error => Object.assign(new Error(message), { name });

describe("toKnowledgeIndexError", () => {
  it.each([
    [
      named("WeaviateStartUpError", "Weaviate failed to startup with message: fetch failed"),
      "CONNECTION",
      true,
    ],
    [
      named(
        "WeaviateQueryError",
        "Query call failed with message: 14 UNAVAILABLE: No connection established",
      ),
      "CONNECTION",
      true,
    ],
    [named("Error", "connect ECONNREFUSED 127.0.0.1:8080"), "CONNECTION", true],
    [named("WeaviateRequestTimeoutError", "request timed out"), "TIMEOUT", true],
    [named("Error", "4 DEADLINE_EXCEEDED: Deadline exceeded"), "TIMEOUT", true],
    [
      named(
        "WeaviateStartUpError",
        'Unauthenticated: {"code":401,"message":"unauthorized: invalid api key"}',
      ),
      "UNAUTHORIZED",
      false,
    ],
    [
      named("Error", "Error in similaritySearch WeaviateQueryError: 7 PERMISSION_DENIED"),
      "UNAUTHORIZED",
      false,
    ],
    [
      named("WeaviateQueryError", "UNKNOWN: vector lengths don't match: 3 vs 1536"),
      "REJECTED",
      false,
    ],
    [named("WeaviateQueryError", "3 INVALID_ARGUMENT: bad filter"), "REJECTED", false],
    [named("Error", "something unexpected"), "SERVER_ERROR", true],
  ])("classifies %s as %s", (error, code, retryable) => {
    const typed = toKnowledgeIndexError(error);

    expect(typed).toBeInstanceOf(KnowledgeIndexUnavailableError);
    expect(typed.code).toBe(code);
    expect(typed.retryable).toBe(retryable);
  });

  it("never copies the original text into the typed error", () => {
    const typed = toKnowledgeIndexError(
      named(
        "WeaviateQueryError",
        "fetch failed for tenant u_0f8fad5bd9cb469fa16570867728950e text=SENTINEL",
      ),
    );

    expect(typed.message).toBe("Knowledge index unavailable: CONNECTION");
    expect(JSON.stringify(typed)).not.toContain("SENTINEL");
    expect(typed.stack ?? "").not.toContain("SENTINEL");
  });

  it("keeps an error that is already typed", () => {
    const own = new KnowledgeIndexUnavailableError("TIMEOUT", true, 2);

    expect(toKnowledgeIndexError(own)).toBe(own);
  });
});

describe("isTenantNotFound", () => {
  it("recognizes the server's missing-tenant answer", () => {
    expect(isTenantNotFound(new Error("Error in similaritySearch ... tenant not found: u_x"))).toBe(
      true,
    );
    expect(isTenantNotFound(new Error("fetch failed"))).toBe(false);
  });
});
