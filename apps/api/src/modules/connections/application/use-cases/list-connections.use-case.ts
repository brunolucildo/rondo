import type { Connection } from "../../domain/connection";
import type { ConnectionRepository } from "../../domain/connection-ports";

export interface ListConnectionsInput {
  /** From the session, never from the request. */
  userId: string;
}

/** The connections of the user, the most recent first (R1). No connections is an empty list. */
export class ListConnections {
  constructor(private readonly repository: ConnectionRepository) {}

  execute({ userId }: ListConnectionsInput): Promise<Connection[]> {
    return this.repository.listByUser(userId);
  }
}
