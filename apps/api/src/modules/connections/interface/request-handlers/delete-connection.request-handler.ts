import { Controller, Delete, HttpCode, HttpStatus, Inject, Param } from "@nestjs/common";
import { ApiException } from "../../../../common/api-exception";
import { type ActiveSession, CurrentSession } from "../../../auth";
import { DeleteConnection } from "../../application/use-cases/delete-connection.use-case";
import { isUuidLike } from "../../domain/connection-rules";
import { toDeletionException } from "../deletion-errors";

@Controller("connections")
export class DeleteConnectionRequestHandler {
  constructor(@Inject(DeleteConnection) private readonly deleteConnection: DeleteConnection) {}

  /**
   * Deletes one connection of the current user: vectors first, then the record. `204` on success,
   * `400` for an id that is not a UUID, `404` for an unknown id or another user's, `409` while it
   * is processing and `503` when the index could not remove the vectors (repeating is safe).
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async handle(@Param("id") id: string, @CurrentSession() session: ActiveSession): Promise<void> {
    if (!isUuidLike(id)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        "VALIDATION_FAILED",
        "The request is invalid.",
        [{ field: "id", message: "Id must be a UUID." }],
      );
    }

    try {
      await this.deleteConnection.execute({ userId: session.userId, connectionId: id });
    } catch (error) {
      throw toDeletionException(error);
    }
  }
}
