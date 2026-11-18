import { ValidationPipe } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { ApiException } from "../../../../common/api-exception";
import { createValidationException } from "../../../../common/validation-exception";
import { GetConversationQueryDto } from "./get-conversation.dto";

// Same options as `configureApp`, so the DTO is checked the way the API runs it.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: createValidationException,
});

async function validate(query: Record<string, string>) {
  try {
    return {
      value: (await pipe.transform(query, {
        type: "query",
        metatype: GetConversationQueryDto,
      })) as GetConversationQueryDto,
    };
  } catch (error) {
    if (error instanceof ApiException) {
      return { details: error.details };
    }

    throw error;
  }
}

describe("GetConversationQueryDto (R2)", () => {
  it("accepts no parameters at all", async () => {
    expect((await validate({})).value).toEqual({});
  });

  it.each(["1", "25", "50"])("accepts limit=%s as a number", async (limit) => {
    expect((await validate({ limit })).value?.limit).toBe(Number(limit));
  });

  it.each(["0", "51", "-1", "1.5", "abc", "", "1e1x"])("refuses limit=%j", async (limit) => {
    expect((await validate({ limit })).details?.[0]).toMatchObject({ field: "limit" });
  });

  it("accepts a cursor-shaped before and refuses anything else", async () => {
    expect((await validate({ before: "OWE4YjdjNmQ" })).value?.before).toBe("OWE4YjdjNmQ");
    expect((await validate({ before: "a b" })).details?.[0]).toMatchObject({ field: "before" });
    expect((await validate({ before: "a".repeat(101) })).details?.[0]).toMatchObject({
      field: "before",
    });
  });

  it("refuses unknown parameters", async () => {
    expect((await validate({ userId: "someone" })).details).toBeDefined();
  });
});
