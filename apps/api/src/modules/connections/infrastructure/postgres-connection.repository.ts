import type { QueryResultRow } from "pg";
import { sqlStateOf } from "../../../common/sql-state";
import type { DatabaseClient, DbCall } from "../../../observability/db-telemetry";
import {
  CONNECTION_ERROR_CODES,
  CONNECTION_KINDS,
  type Connection,
  type ConnectionErrorCode,
  type ConnectionKind,
  type ConnectionStatus,
} from "../domain/connection";
import type {
  ConnectionRepository,
  InsertedConnection,
  NewConnection,
} from "../domain/connection-ports";
import { DataAccessError } from "./data-access-error";

const COLUMNS =
  "id, user_id, kind, name, size_bytes, content_hash, status, chunk_count, error_code, created_at, updated_at";

const STATUSES: readonly ConnectionStatus[] = ["processing", "ready", "failed"];

interface ConnectionRow extends QueryResultRow {
  id: unknown;
  user_id: unknown;
  kind: unknown;
  name: unknown;
  /** `bigint` arrives as a string. */
  size_bytes: unknown;
  content_hash: unknown;
  status: unknown;
  chunk_count: unknown;
  error_code: unknown;
  created_at: unknown;
  updated_at: unknown;
}

const asDate = (value: unknown): Date | null =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;

function toConnection(operation: string, row: ConnectionRow): Connection {
  const sizeBytes = Number(row.size_bytes);
  const createdAt = asDate(row.created_at);
  const updatedAt = asDate(row.updated_at);

  if (
    typeof row.id !== "string" ||
    typeof row.user_id !== "string" ||
    typeof row.name !== "string" ||
    typeof row.content_hash !== "string" ||
    !CONNECTION_KINDS.includes(row.kind as ConnectionKind) ||
    !STATUSES.includes(row.status as ConnectionStatus) ||
    !Number.isSafeInteger(sizeBytes) ||
    typeof row.chunk_count !== "number" ||
    (row.error_code !== null &&
      !CONNECTION_ERROR_CODES.includes(row.error_code as ConnectionErrorCode)) ||
    createdAt === null ||
    updatedAt === null
  ) {
    throw new DataAccessError(operation, "UNEXPECTED_RESULT");
  }

  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as ConnectionKind,
    name: row.name,
    sizeBytes,
    contentHash: row.content_hash,
    status: row.status as ConnectionStatus,
    chunkCount: row.chunk_count,
    errorCode: row.error_code as ConnectionErrorCode | null,
    createdAt,
    updatedAt,
  };
}

/** `ConnectionRepository` over Postgres: parameterized SQL, explicit columns, always scoped by user. */
export class PostgresConnectionRepository implements ConnectionRepository {
  constructor(private readonly database: DatabaseClient) {}

  private async run(
    operation: string,
    call: DbCall,
    text: string,
    values: readonly unknown[],
  ): Promise<ConnectionRow[]> {
    try {
      return (await this.database.query<ConnectionRow>(call, text, values)).rows;
    } catch (error) {
      throw new DataAccessError(operation, sqlStateOf(error));
    }
  }

  private async one(
    operation: string,
    call: DbCall,
    text: string,
    values: readonly unknown[],
  ): Promise<Connection | null> {
    const [row] = await this.run(operation, call, text, values);

    return row === undefined ? null : toConnection(operation, row);
  }

  findById(userId: string, connectionId: string): Promise<Connection | null> {
    return this.one(
      "connections_find_by_id",
      { operation: "select", collection: "connections" },
      `select ${COLUMNS} from public.connections where id = $1 and user_id = $2`,
      [connectionId, userId],
    );
  }

  findByContentHash(userId: string, contentHash: string): Promise<Connection | null> {
    return this.one(
      "connections_find_by_hash",
      { operation: "select", collection: "connections" },
      `select ${COLUMNS} from public.connections where user_id = $1 and content_hash = $2`,
      [userId, contentHash],
    );
  }

  async countByUser(userId: string): Promise<number> {
    const [row] = await this.run(
      "connections_count",
      { operation: "select", collection: "connections" },
      "select count(*)::int as total from public.connections where user_id = $1",
      [userId],
    );
    const total: unknown = row?.total;

    if (typeof total !== "number") {
      throw new DataAccessError("connections_count", "UNEXPECTED_RESULT");
    }

    return total;
  }

  async insertProcessing(userId: string, connection: NewConnection): Promise<InsertedConnection> {
    const inserted = await this.one(
      "connections_insert",
      { operation: "insert", collection: "connections" },
      `insert into public.connections (user_id, kind, name, size_bytes, content_hash, status)
       values ($1, $2, $3, $4, $5, 'processing')
       on conflict (user_id, content_hash) do nothing
       returning ${COLUMNS}`,
      [userId, connection.kind, connection.name, connection.sizeBytes, connection.contentHash],
    );

    if (inserted !== null) {
      return { connection: inserted, created: true };
    }

    // The unique index said another request got there first: that row is the answer.
    const existing = await this.findByContentHash(userId, connection.contentHash);

    if (existing === null) {
      throw new DataAccessError("connections_insert", "UNEXPECTED_RESULT");
    }

    return { connection: existing, created: false };
  }

  claimFailed(userId: string, connectionId: string): Promise<Connection | null> {
    return this.one(
      "connections_claim_failed",
      { operation: "update", collection: "connections" },
      `update public.connections
          set status = 'processing', error_code = null, chunk_count = 0, updated_at = now()
        where id = $1 and user_id = $2 and status = 'failed'
        returning ${COLUMNS}`,
      [connectionId, userId],
    );
  }

  failIfStale(
    userId: string,
    connectionId: string,
    cutoff: Date,
    errorCode: ConnectionErrorCode,
  ): Promise<Connection | null> {
    return this.one(
      "connections_fail_if_stale",
      { operation: "update", collection: "connections" },
      `update public.connections
          set status = 'failed', error_code = $4, updated_at = now()
        where id = $1 and user_id = $2 and status = 'processing' and updated_at < $3
        returning ${COLUMNS}`,
      [connectionId, userId, cutoff.toISOString(), errorCode],
    );
  }

  async markReady(userId: string, connectionId: string, chunkCount: number): Promise<void> {
    await this.run(
      "connections_mark_ready",
      { operation: "update", collection: "connections" },
      `update public.connections
          set status = 'ready', error_code = null, chunk_count = $3, updated_at = now()
        where id = $1 and user_id = $2`,
      [connectionId, userId, chunkCount],
    );
  }

  async markFailed(
    userId: string,
    connectionId: string,
    errorCode: ConnectionErrorCode,
  ): Promise<void> {
    await this.run(
      "connections_mark_failed",
      { operation: "update", collection: "connections" },
      `update public.connections
          set status = 'failed', error_code = $3, chunk_count = 0, updated_at = now()
        where id = $1 and user_id = $2`,
      [connectionId, userId, errorCode],
    );
  }
}
