import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { EXPERT_LIMITS } from "../../domain/expert-rules";

const LIMIT_RANGE = `Limit must be between 1 and ${EXPERT_LIMITS.pageSizeMax}.`;
const BAD_CURSOR = "Before is not a valid cursor.";

/**
 * Query of `GET /api/v1/experts/:expertId/conversation`. `limit` is a whole number from 1 to 50
 * (anything else is `400 VALIDATION_FAILED`); `before` is the opaque `nextCursor` of a previous page.
 */
export class GetConversationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "Limit must be a whole number." })
  @Min(1, { message: LIMIT_RANGE })
  @Max(EXPERT_LIMITS.pageSizeMax, { message: LIMIT_RANGE })
  limit?: number;

  @IsOptional()
  @IsString({ message: "Before must be text." })
  @MaxLength(100, { message: BAD_CURSOR })
  @Matches(/^[A-Za-z0-9_-]+$/, { message: BAD_CURSOR })
  before?: string;
}
