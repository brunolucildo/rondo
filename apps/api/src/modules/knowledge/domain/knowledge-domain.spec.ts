import { describe, expect, it } from "vitest";
import { parseKnowledgeConfig } from "./knowledge-config";
import { KnowledgeIndexUnavailableError } from "./knowledge-errors";
import { isUuid, tenantNameOf } from "./knowledge-rules";

describe("tenantNameOf", () => {
  it("derives a stable, server-valid name from the user id", () => {
    const userId = "0F8FAD5B-D9CB-469F-A165-70867728950E";

    expect(tenantNameOf(userId)).toBe("u_0f8fad5bd9cb469fa16570867728950e");
    expect(tenantNameOf(userId.toLowerCase())).toBe(tenantNameOf(userId));
    expect(tenantNameOf(userId)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("gives different users different tenants", () => {
    expect(tenantNameOf("0f8fad5b-d9cb-469f-a165-70867728950e")).not.toBe(
      tenantNameOf("1f8fad5b-d9cb-469f-a165-70867728950e"),
    );
  });
});

describe("isUuid", () => {
  it("accepts UUIDs and refuses anything else", () => {
    expect(isUuid("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
    expect(isUuid("0f8fad5bd9cb469fa16570867728950e")).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid("")).toBe(false);
  });
});

describe("KnowledgeIndexUnavailableError", () => {
  it("has a fixed message that names only the category", () => {
    const error = new KnowledgeIndexUnavailableError("CONNECTION", true);

    expect(error.message).toBe("Knowledge index unavailable: CONNECTION");
    expect(error.withAttempts(3).attempts).toBe(3);
    expect(error.withAttempts(3).retryable).toBe(true);
  });
});

describe("parseKnowledgeConfig", () => {
  const base = { WEAVIATE_URL: "http://localhost:8080", WEAVIATE_API_KEY: "dev-key" };

  it("reads the URL, the key and the defaults; OPENAI_API_KEY is optional", () => {
    const config = parseKnowledgeConfig(base);

    expect(config.weaviateUrl.hostname).toBe("localhost");
    expect(config.weaviateGrpcPort).toBe(50051);
    expect(config.collection).toBe("KnowledgeChunk");
    expect(config.openAiApiKey).toBeUndefined();
    expect(parseKnowledgeConfig({ ...base, OPENAI_API_KEY: " sk-x " }).openAiApiKey).toBe("sk-x");
  });

  it("fails naming the variable and never echoing a value", () => {
    expect(() => parseKnowledgeConfig({ WEAVIATE_API_KEY: "dev-key" })).toThrow(/WEAVIATE_URL/);
    expect(() => parseKnowledgeConfig({ WEAVIATE_URL: base.WEAVIATE_URL })).toThrow(
      /WEAVIATE_API_KEY/,
    );
    expect(() => parseKnowledgeConfig({ ...base, WEAVIATE_URL: "ftp://x" })).toThrow(/http\(s\)/);
    expect(() => parseKnowledgeConfig({ ...base, WEAVIATE_GRPC_PORT: "abc" })).toThrow(
      /WEAVIATE_GRPC_PORT/,
    );
    expect(() => parseKnowledgeConfig({ ...base, WEAVIATE_COLLECTION: "lower" })).toThrow(
      /WEAVIATE_COLLECTION/,
    );

    try {
      parseKnowledgeConfig({ ...base, WEAVIATE_URL: "definitely not a url secret-123" });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("secret-123");
    }
  });
});
