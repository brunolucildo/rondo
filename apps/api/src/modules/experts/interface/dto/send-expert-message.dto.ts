import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { EXPERT_LIMITS, EXPERT_MESSAGE_ROLES } from "../../domain/expert-rules";

const TOO_LONG = `Messages must have at most ${EXPERT_LIMITS.contentMax} characters.`;

/** One previous message. The role is `user` or `assistant`: history can never be a system message. */
export class ChatTurnDto {
  @IsIn(EXPERT_MESSAGE_ROLES, { message: "Role must be user or assistant." })
  role!: "user" | "assistant";

  @IsString({ message: "Content must be text." })
  @IsNotEmpty({ message: "Content must not be empty." })
  @MaxLength(EXPERT_LIMITS.contentMax, { message: TOO_LONG })
  content!: string;
}

/**
 * Body of `POST /api/v1/experts/:expertId/messages`. Unknown properties are rejected by the
 * global pipe. The text is kept exactly as sent (a suggested question is sent without edits).
 */
export class SendExpertMessageDto {
  @IsString({ message: "Message must be text." })
  @Matches(/\S/, { message: "Write a message." })
  @MaxLength(EXPERT_LIMITS.contentMax, { message: TOO_LONG })
  content!: string;

  @IsOptional()
  @IsArray({ message: "History must be a list." })
  @ArrayMaxSize(EXPERT_LIMITS.historyMax, {
    message: `History must have at most ${EXPERT_LIMITS.historyMax} messages.`,
  })
  @ValidateNested({ each: true })
  @Type(() => ChatTurnDto)
  history: ChatTurnDto[] = [];
}
