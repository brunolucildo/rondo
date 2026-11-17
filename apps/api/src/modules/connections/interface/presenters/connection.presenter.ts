import type {
  Connection,
  ConnectionErrorCode,
  ConnectionKind,
  ConnectionStatus,
} from "../../domain/connection";

export interface ConnectionResponse {
  id: string;
  name: string;
  kind: ConnectionKind;
  sizeBytes: number;
  status: ConnectionStatus;
  chunkCount: number;
  errorCode: ConnectionErrorCode | null;
  createdAt: string;
}

/** The public face of a connection: no `userId`, no content hash. */
export function presentConnection(connection: Connection): ConnectionResponse {
  return {
    id: connection.id,
    name: connection.name,
    kind: connection.kind,
    sizeBytes: connection.sizeBytes,
    status: connection.status,
    chunkCount: connection.chunkCount,
    errorCode: connection.errorCode,
    createdAt: connection.createdAt.toISOString(),
  };
}

export interface UploadConnectionResponse extends ConnectionResponse {
  /** True when the content was already connected and nothing was processed again. */
  deduplicated: boolean;
}

export function presentUpload(
  connection: Connection,
  deduplicated: boolean,
): UploadConnectionResponse {
  return { ...presentConnection(connection), deduplicated };
}

export interface ConnectionListResponse {
  connections: ConnectionResponse[];
}

export function presentConnectionList(connections: readonly Connection[]): ConnectionListResponse {
  return { connections: connections.map(presentConnection) };
}
