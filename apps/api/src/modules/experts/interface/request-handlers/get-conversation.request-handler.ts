import { Controller, Get, HttpStatus, Inject, Param, Query } from "@nestjs/common";
import { ApiException } from "../../../../common/api-exception";
import { type ActiveSession, CurrentSession } from "../../../auth";
import { GetConversation } from "../../application/use-cases/get-conversation.use-case";
import { ExpertNotFoundError, InvalidCursorError } from "../../domain/expert-errors";
import { GetConversationQueryDto } from "../dto/get-conversation.dto";
import {
  type ConversationResponse,
  presentConversation,
} from "../presenters/conversation.presenter";

@Controller("experts")
export class GetConversationRequestHandler {
  constructor(@Inject(GetConversation) private readonly getConversation: GetConversation) {}

  /**
   * The messages of the conversation of the session user with an expert, oldest first within the
   * page and at most 50 per page; `nextCursor` leads to the older ones. The user id comes from the
   * session only (closed by default: no session, no answer). No conversation is an empty list.
   */
  @Get(":expertId/conversation")
  async handle(
    @Param("expertId") expertId: string,
    @Query() query: GetConversationQueryDto,
    @CurrentSession() session: ActiveSession,
  ): Promise<ConversationResponse> {
    try {
      return presentConversation(
        await this.getConversation.execute({
          userId: session.userId,
          expertId,
          limit: query.limit,
          before: query.before,
        }),
      );
    } catch (error) {
      if (error instanceof ExpertNotFoundError) {
        throw new ApiException(HttpStatus.NOT_FOUND, "EXPERT_NOT_FOUND", "Expert not found.");
      }

      if (error instanceof InvalidCursorError) {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          "VALIDATION_FAILED",
          "The request is invalid.",
          [{ field: "before", message: "Before is not a valid cursor." }],
        );
      }

      throw error;
    }
  }
}
