import { randomUUID } from "node:crypto";
import type { Connection, ConnectionErrorCode } from "../domain/connection";
import type {
  ConnectionRepository,
  InsertedConnection,
  NewConnection,
} from "../domain/connection-ports";

/**
 * `ConnectionRepository` in memory, with the same semantics as the Postgres one (unique
 * `(user, hash)`, atomic claim, scoped by user). `now` is injectable so tests control the clock.
 */
export class InMemoryConnectionRepository implements ConnectionRepository {
  readonly rows = new Map<string, Connection>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  findById(userId: string, connectionId: string): Promise<Connection | null> {
    const row = this.rows.get(connectionId);

    return Promise.resolve(row?.userId === userId ? { ...row } : null);
  }

  findByContentHash(userId: string, contentHash: string): Promise<Connection | null> {
    const row = [...this.rows.values()].find(
      (candidate) => candidate.userId === userId && candidate.contentHash === contentHash,
    );

    return Promise.resolve(row === undefined ? null : { ...row });
  }

  countByUser(userId: string): Promise<number> {
    return Promise.resolve([...this.rows.values()].filter((row) => row.userId === userId).length);
  }

  hasReadyConnection(userId: string): Promise<boolean> {
    return Promise.resolve(
      [...this.rows.values()].some((row) => row.userId === userId && row.status === "ready"),
    );
  }

  insertProcessing(userId: string, connection: NewConnection): Promise<InsertedConnection> {
    // No `await` between the lookup and the insert: like the unique index, one caller wins.
    const existing = [...this.rows.values()].find(
      (row) => row.userId === userId && row.contentHash === connection.contentHash,
    );

    if (existing !== undefined) {
      return Promise.resolve({ connection: { ...existing }, created: false });
    }

    const now = this.now();
    const row: Connection = {
      id: randomUUID(),
      userId,
      ...connection,
      status: "processing",
      chunkCount: 0,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
    };

    this.rows.set(row.id, row);

    return Promise.resolve({ connection: { ...row }, created: true });
  }

  claimFailed(userId: string, connectionId: string): Promise<Connection | null> {
    const row = this.rows.get(connectionId);

    if (row?.userId !== userId || row.status !== "failed") {
      return Promise.resolve(null);
    }

    Object.assign(row, {
      status: "processing",
      errorCode: null,
      chunkCount: 0,
      updatedAt: this.now(),
    });

    return Promise.resolve({ ...row });
  }

  failIfStale(
    userId: string,
    connectionId: string,
    cutoff: Date,
    errorCode: ConnectionErrorCode,
  ): Promise<Connection | null> {
    const row = this.rows.get(connectionId);

    if (row?.userId !== userId || row.status !== "processing" || row.updatedAt >= cutoff) {
      return Promise.resolve(null);
    }

    Object.assign(row, { status: "failed", errorCode, updatedAt: this.now() });

    return Promise.resolve({ ...row });
  }

  markReady(userId: string, connectionId: string, chunkCount: number): Promise<void> {
    const row = this.rows.get(connectionId);

    if (row?.userId === userId) {
      Object.assign(row, { status: "ready", errorCode: null, chunkCount, updatedAt: this.now() });
    }

    return Promise.resolve();
  }

  markFailed(userId: string, connectionId: string, errorCode: ConnectionErrorCode): Promise<void> {
    const row = this.rows.get(connectionId);

    if (row?.userId === userId) {
      Object.assign(row, { status: "failed", errorCode, chunkCount: 0, updatedAt: this.now() });
    }

    return Promise.resolve();
  }
}
