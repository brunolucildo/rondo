import { Controller, Get, HttpStatus, Inject, Param } from "@nestjs/common";
import { ApiException } from "../../../../common/api-exception";
import { type ActiveSession, CurrentSession } from "../../../auth";
import { GetConnection } from "../../application/use-cases/get-connection.use-case";
import { ConnectionNotFoundError } from "../../domain/connection-errors";
import { isUuidLike } from "../../domain/connection-rules";
import { type ConnectionResponse, presentConnection } from "../presenters/connection.presenter";

@Controller("connections")
export class GetConnectionRequestHandler {
  constructor(@Inject(GetConnection) private readonly getConnection: GetConnection) {}

  /**
   * The status of one connection of the current user. Another user's connection, an unknown id and
   * an id that is not a UUID all answer the same `404 CONNECTION_NOT_FOUND`.
   */
  @Get(":id")
  async handle(
    @Param("id") id: string,
    @CurrentSession() session: ActiveSession,
  ): Promise<ConnectionResponse> {
    try {
      if (!isUuidLike(id)) {
        throw new ConnectionNotFoundError();
      }

      return presentConnection(
        await this.getConnection.execute({ userId: session.userId, connectionId: id }),
      );
    } catch (error) {
      if (error instanceof ConnectionNotFoundError) {
        throw new ApiException(
          HttpStatus.NOT_FOUND,
          "CONNECTION_NOT_FOUND",
          "Connection not found.",
        );
      }

      throw error;
    }
  }
}
