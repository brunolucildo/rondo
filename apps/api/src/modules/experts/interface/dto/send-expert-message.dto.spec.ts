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

  it("rejects any other field: only the content is accepted", async () => {
    expect((await validate({ content: "oi", expertId: "head-coach" })).details).toBeDefined();
    expect((await validate({ content: "oi", userId: "someone" })).details).toBeDefined();
  });
});
