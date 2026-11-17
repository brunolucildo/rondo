import type { Connection } from "../../domain/connection";
import { ConnectionNotFoundError } from "../../domain/connection-errors";
import type { ConnectionRepository } from "../../domain/connection-ports";
import { isStaleProcessing, STALE_PROCESSING_MS } from "../../domain/connection-rules";

export interface GetConnectionInput {
  /** From the session, never from the request. */
  userId: string;
  connectionId: string;
}

/**
 * The status of one connection of the user (R7). Another user's connection and an unknown id are
 * the same `ConnectionNotFoundError`. A `processing` connection older than 15 minutes lost its
 * worker (the API restarted): it is turned into `failed` with `PROCESSING_UNAVAILABLE` on the spot.
 */
export class GetConnection {
  constructor(
    private readonly repository: ConnectionRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute({ userId, connectionId }: GetConnectionInput): Promise<Connection> {
    const connection = await this.repository.findById(userId, connectionId);

    if (connection === null) {
      throw new ConnectionNotFoundError();
    }

    if (!isStaleProcessing(connection, this.now())) {
      return connection;
    }

    const cutoff = new Date(this.now().getTime() - STALE_PROCESSING_MS);

    return (
      (await this.repository.failIfStale(userId, connectionId, cutoff, "PROCESSING_UNAVAILABLE")) ??
      (await this.repository.findById(userId, connectionId)) ??
      connection
    );
  }
}
