import { IsString, Matches, MaxLength } from "class-validator";
import { EXPERT_LIMITS } from "../../domain/expert-rules";

/**
 * Body of `POST /api/v1/experts/:expertId/messages`: only the new message. The history lives on
 * the server (0020), so any other property, `history` included, is rejected by the global pipe.
 * The text is kept exactly as sent (a suggested question is sent without edits).
 */
export class SendExpertMessageDto {
  @IsString({ message: "Message must be text." })
  @Matches(/\S/, { message: "Write a message." })
  @MaxLength(EXPERT_LIMITS.contentMax, {
    message: `Messages must have at most ${EXPERT_LIMITS.contentMax} characters.`,
  })
  content!: string;
}
