import { Body, Controller, HttpStatus, Inject, Param, Post, Req, Res } from "@nestjs/common";
import { ApiException } from "../../../../common/api-exception";
import { logExpertMessage, traceExpertMessage } from "../../../../observability/expert-telemetry";
import { type ActiveSession, CurrentSession } from "../../../auth";
import { RateLimit } from "../../../rate-limit";
import { SendExpertMessage } from "../../application/use-cases/send-expert-message.use-case";
import {
  ConversationBusyError,
  ExpertNotFoundError,
  ExpertUnavailableError,
} from "../../domain/expert-errors";
import { type StreamResponse, writeAnswerStream } from "../answer-stream";
import { SendExpertMessageDto } from "../dto/send-expert-message.dto";

interface RequestWithId {
  id?: unknown;
}

interface ClosableResponse extends StreamResponse {
  on(event: "close", listener: () => void): unknown;
}

@Controller("experts")
export class SendExpertMessageRequestHandler {
  constructor(@Inject(SendExpertMessage) private readonly sendExpertMessage: SendExpertMessage) {}

  /**
   * Sends one message to an expert and streams the answer (Server-Sent Events). Problems that
   * exist before the first byte (unknown expert, no model configured, bad body, limit) answer
   * with the usual error envelope; after the stream starts, a failure is an `error` event.
   * The conversation is read from and written to the database for the session user (the body
   * carries only `content`); a second answer for the same user and expert gets `409
   * CONVERSATION_BUSY`. Limited per IP: the limiter runs before authentication.
   */
  @Post(":expertId/messages")
  @RateLimit("expert-message")
  async handle(
    @Param("expertId") expertId: string,
    @Body() body: SendExpertMessageDto,
    @CurrentSession() session: ActiveSession,
    @Req() request: RequestWithId,
    @Res() response: ClosableResponse,
  ): Promise<void> {
    const abort = new AbortController();
    const requestId = typeof request.id === "string" ? request.id : undefined;
    // Registered before the first await: a client that leaves while the conversation is being read
    // (Stop, closed tab) must still stop the answer, which then ends without calling the model.
    response.on("close", () => {
      if (!response.writableEnded) {
        abort.abort();
      }
    });

    let sent;

    try {
      sent = await this.sendExpertMessage.execute({
        userId: session.userId,
        expertId,
        content: body.content,
        signal: abort.signal,
      });
    } catch (error) {
      if (error instanceof ConversationBusyError) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "CONVERSATION_BUSY",
          "This expert is still answering.",
        );
      }

      if (error instanceof ExpertNotFoundError) {
        throw new ApiException(HttpStatus.NOT_FOUND, "EXPERT_NOT_FOUND", "Expert not found.");
      }

      if (error instanceof ExpertUnavailableError) {
        logExpertMessage(
          { expertId, requestId },
          { outcome: "failure", reason: "unavailable", inputTokens: null, outputTokens: null },
          0,
        );
        throw new ApiException(
          HttpStatus.SERVICE_UNAVAILABLE,
          "EXPERT_UNAVAILABLE",
          "The experts are unavailable right now.",
        );
      }

      throw error;
    }

    try {
      await traceExpertMessage({ expertId, requestId }, () =>
        writeAnswerStream(response, sent.events),
      );
    } finally {
      sent.release();
    }
  }
}
