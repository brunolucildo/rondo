import { HttpStatus } from "@nestjs/common";
import { ApiException } from "../../../common/api-exception";
import {
  ConnectionBusyError,
  ConnectionIndexUnavailableError,
  ConnectionNotFoundError,
} from "../domain/connection-errors";

/**
 * The API error of a failed deletion: the fixed messages never carry a name, an id or a cause.
 * Anything it does not know is returned as it came (the global filter answers 500).
 */
export function toDeletionException(error: unknown): unknown {
  if (error instanceof ConnectionNotFoundError) {
    return new ApiException(HttpStatus.NOT_FOUND, "CONNECTION_NOT_FOUND", "Connection not found.");
  }

  if (error instanceof ConnectionBusyError) {
    return new ApiException(
      HttpStatus.CONFLICT,
      "CONNECTION_PROCESSING",
      "A connection is still being processed. Wait for it to finish.",
    );
  }

  if (error instanceof ConnectionIndexUnavailableError) {
    return new ApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      "KNOWLEDGE_UNAVAILABLE",
      "We couldn't delete the connection right now. Try again.",
    );
  }

  return error;
}
