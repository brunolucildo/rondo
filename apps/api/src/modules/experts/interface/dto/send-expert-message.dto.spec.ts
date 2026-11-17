import { ValidationPipe } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { ApiException } from "../../../../common/api-exception";
import { createValidationException } from "../../../../common/validation-exception";
import { SendExpertMessageDto } from "./send-expert-message.dto";

// Same options as `configureApp`, so the DTO is checked the way the API runs it.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: createValidationException,
});

async function validate(body: unknown) {
  try {
    return {
      value: (await pipe.transform(body, {
        type: "body",
        metatype: SendExpertMessageDto,
      })) as SendExpertMessageDto,
    };
  } catch (error) {
    if (error instanceof ApiException) {
      return { details: error.details };
    }

    throw error;
  }
}

describe("SendExpertMessageDto (R4, R5)", () => {
  it("accepts a message and keeps the text exactly as sent", async () => {
    const { value } = await validate({ content: "  Qual escalação?  " });

    expect(value?.content).toBe("  Qual escalação?  ");
  });

  it("accepts exactly 4000 characters and refuses 4001", async () => {
    expect((await validate({ content: "a".repeat(4000) })).value).toBeDefined();

    const { details } = await validate({ content: "a".repeat(4001) });

    expect(details?.[0]).toMatchObject({ field: "content" });
  });

  it.each(["", "   ", "\n\t "])("refuses a blank message (%j)", async (content) => {
    expect((await validate({ content })).details?.[0]).toMatchObject({ field: "content" });
  });

  it("refuses a message that is not text", async () => {
    expect((await validate({ content: 42 })).details).toBeDefined();
    expect((await validate({})).details).toBeDefined();
  });

  it.each([[[{ role: "user", content: "oi" }]], [[]], ["nope"]])(
    "rejects the removed history field (%j)",
    async (history) => {
      const { details } = await validate({ content: "oi", history });

      expect(details?.[0]).toMatchObject({ field: "history" });
    },
  );

  describe("connectionIds (R2)", () => {
    const A = "6d2f3c1a-9b7e-4d58-8a31-2c4e5f6a7b8c";
    const B = "7e3a4d2b-0c8f-4e69-9b42-3d5f6a7b8c9d";

    it("is optional and keeps up to 10 distinct UUIDs", async () => {
      expect((await validate({ content: "oi" })).value?.connectionIds).toBeUndefined();
      expect(
        (await validate({ content: "oi", connectionIds: [A, B] })).value?.connectionIds,
      ).toEqual([A, B]);
      expect((await validate({ content: "oi", connectionIds: [] })).value?.connectionIds).toEqual(
        [],
      );

      const ten = Array.from(
        { length: 10 },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );

      expect((await validate({ content: "oi", connectionIds: ten })).value).toBeDefined();
    });

    it("refuses more than 10 ids, repeated ids, non UUIDs and a non-list", async () => {
      const eleven = Array.from(
        { length: 11 },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );

      for (const connectionIds of [eleven, [A, A], ["not-a-uuid"], [42], A, { 0: A }]) {
        expect((await validate({ content: "oi", connectionIds })).details?.[0]).toMatchObject({
          field: "connectionIds",
        });
      }
    });
  });

  it("rejects any other field: only the content is accepted", async () => {
    expect((await validate({ content: "oi", expertId: "head-coach" })).details).toBeDefined();
    expect((await validate({ content: "oi", userId: "someone" })).details).toBeDefined();
  });
});
