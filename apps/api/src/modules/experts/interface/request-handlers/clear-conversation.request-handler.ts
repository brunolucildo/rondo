import { Controller, Delete, HttpCode, HttpStatus, Inject, Param } from "@nestjs/common";
import { ApiException } from "../../../../common/api-exception";
import { type ActiveSession, CurrentSession } from "../../../auth";
import { ClearConversation } from "../../application/use-cases/clear-conversation.use-case";
import { ExpertNotFoundError } from "../../domain/expert-errors";

@Controller("experts")
export class ClearConversationRequestHandler {
  constructor(@Inject(ClearConversation) private readonly clearConversation: ClearConversation) {}

  /**
   * "Clear conversation": deletes every message of the session user with the expert. Idempotent
   * (`204` even when there is nothing to delete) and it can only reach the user's own conversation.
   */
  @Delete(":expertId/conversation")
  @HttpCode(HttpStatus.NO_CONTENT)
  async handle(
    @Param("expertId") expertId: string,
    @CurrentSession() session: ActiveSession,
  ): Promise<void> {
    try {
      await this.clearConversation.execute({ userId: session.userId, expertId });
    } catch (error) {
      if (error instanceof ExpertNotFoundError) {
        throw new ApiException(HttpStatus.NOT_FOUND, "EXPERT_NOT_FOUND", "Expert not found.");
      }

      throw error;
    }
  }
}
