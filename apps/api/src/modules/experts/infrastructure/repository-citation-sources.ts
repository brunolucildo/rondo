import { type ConnectionRepository } from "../../connections";
import type { CitationSources } from "../domain/expert-ports";

/**
 * `CitationSources` over the connections module: which cited connections still exist for the user.
 * Scoped by the user id of the session, so another user's connection counts as gone.
 */
export class RepositoryCitationSources implements CitationSources {
  constructor(private readonly connections: ConnectionRepository) {}

  async existingConnectionIds(
    userId: string,
    connectionIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (connectionIds.length === 0) {
      return new Set();
    }

    return new Set(await this.connections.findExistingIds(userId, connectionIds));
  }
}
