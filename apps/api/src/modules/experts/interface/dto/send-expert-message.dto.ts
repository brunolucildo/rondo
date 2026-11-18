import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from "class-validator";
import { EXPERT_LIMITS, MAX_ATTACHED_CONNECTIONS } from "../../domain/expert-rules";

/**
 * Body of `POST /api/v1/experts/:expertId/messages`: the new message and, optionally, the
 * connections attached to it. The history lives on the server (0020), so any other property,
 * `history` included, is rejected by the global pipe, and so is a `userId`: the owner always
 * comes from the session. The text is kept exactly as sent (a suggested question is sent without
 * edits).
 */
export class SendExpertMessageDto {
  @IsString({ message: "Message must be text." })
  @Matches(/\S/, { message: "Write a message." })
  @MaxLength(EXPERT_LIMITS.contentMax, {
    message: `Messages must have at most ${EXPERT_LIMITS.contentMax} characters.`,
  })
  content!: string;

  /**
   * Restricts the search to these connections (spec 0024): at most 10 distinct UUIDs, all of the
   * session user and `ready`. Absent or empty searches the whole base of the user.
   */
  @IsOptional()
  @IsArray({ message: "connectionIds must be a list." })
  @ArrayMaxSize(MAX_ATTACHED_CONNECTIONS, {
    message: `You can attach at most ${MAX_ATTACHED_CONNECTIONS} connections to a message.`,
  })
  @ArrayUnique({ message: "connectionIds must not repeat." })
  @IsUUID("all", { each: true, message: "connectionIds must be UUIDs." })
  connectionIds?: string[];
}
