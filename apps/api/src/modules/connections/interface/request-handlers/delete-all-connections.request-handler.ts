import { Controller, Delete, HttpCode, HttpStatus, Inject } from "@nestjs/common";
import { type ActiveSession, CurrentSession } from "../../../auth";
import { DeleteAllConnections } from "../../application/use-cases/delete-all-connections.use-case";
import { toDeletionException } from "../deletion-errors";

@Controller("connections")
export class DeleteAllConnectionsRequestHandler {
  constructor(
    @Inject(DeleteAllConnections) private readonly deleteAllConnections: DeleteAllConnections,
  ) {}

  /**
   * Deletes every connection of the current user and their tenant in the index. `204` (also when
   * there was nothing to delete), `409` when one is still processing (nothing is deleted) and
   * `503` when the index failed (nothing else is deleted; repeating is safe).
   */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async handle(@CurrentSession() session: ActiveSession): Promise<void> {
    try {
      await this.deleteAllConnections.execute({ userId: session.userId });
    } catch (error) {
      throw toDeletionException(error);
    }
  }
}
