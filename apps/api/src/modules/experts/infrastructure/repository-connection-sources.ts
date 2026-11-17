import { type ConnectionRepository } from "../../connections";
import { ConnectionNotFoundError, ConnectionNotReadyError } from "../domain/expert-errors";
import type { ConnectionSources } from "../domain/expert-ports";

/**
 * `ConnectionSources` over the connections module. Every lookup goes through the repository with
 * the user id of the session, so an id of another user is indistinguishable from an unknown one.
 */
export class RepositoryConnectionSources implements ConnectionSources {
  constructor(private readonly connections: ConnectionRepository) {}

  async assertAttachable(userId: string, connectionIds: readonly string[]): Promise<void> {
    const found = await Promise.all(
      connectionIds.map((id) => this.connections.findById(userId, id)),
    );

    // Existence first: a missing id is a 404 even when another one is still processing.
    if (found.some((connection) => connection === null)) {
      throw new ConnectionNotFoundError();
    }

    if (found.some((connection) => connection?.status !== "ready")) {
      throw new ConnectionNotReadyError();
    }
  }

  hasReadyConnection(userId: string): Promise<boolean> {
    return this.connections.hasReadyConnection(userId);
  }
}
