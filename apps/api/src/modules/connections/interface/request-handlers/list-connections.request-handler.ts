import { Controller, Get, Inject } from "@nestjs/common";
import { type ActiveSession, CurrentSession } from "../../../auth";
import { ListConnections } from "../../application/use-cases/list-connections.use-case";
import {
  type ConnectionListResponse,
  presentConnectionList,
} from "../presenters/connection.presenter";

@Controller("connections")
export class ListConnectionsRequestHandler {
  constructor(@Inject(ListConnections) private readonly listConnections: ListConnections) {}

  /** The connections of the current user, the most recent first. None is an empty list. */
  @Get()
  async handle(@CurrentSession() session: ActiveSession): Promise<ConnectionListResponse> {
    return presentConnectionList(await this.listConnections.execute({ userId: session.userId }));
  }
}
