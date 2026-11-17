import { KnowledgeIndexUnavailableError } from "../domain/knowledge-errors";

/**
 * Maps whatever the Weaviate client (or the LangChain store, which re-wraps client errors as
 * plain `Error` text) threw to the typed error. Only the text is inspected, to pick a category:
 * it is never copied into the result, because it can repeat chunk text, vectors or the tenant.
 *
 * Authentication and caller faults are not retryable; connection, timeout and server failures are.
 */
export function toKnowledgeIndexError(error: unknown): KnowledgeIndexUnavailableError {
  if (error instanceof KnowledgeIndexUnavailableError) {
    return error;
  }

  const text = `${error instanceof Error ? `${error.name} ${error.message}` : ""}`;

  if (/unauthenticated|unauthorized|forbidden|permission[_ ]?denied|\b40[13]\b/i.test(text)) {
    return new KnowledgeIndexUnavailableError("UNAUTHORIZED", false);
  }

  if (/invalid[_ ]argument|vector lengths|\b(400|422)\b/i.test(text)) {
    return new KnowledgeIndexUnavailableError("REJECTED", false);
  }

  if (/timeout|timed out|deadline[_ ]exceeded|abort/i.test(text)) {
    return new KnowledgeIndexUnavailableError("TIMEOUT", true);
  }

  if (
    /fetch failed|econnrefused|econnreset|enotfound|eai_again|socket|unavailable|no connection|connect/i.test(
      text,
    )
  ) {
    return new KnowledgeIndexUnavailableError("CONNECTION", true);
  }

  return new KnowledgeIndexUnavailableError("SERVER_ERROR", true);
}

/** True when the error says the user's tenant does not exist (a search then has nothing to return). */
export function isTenantNotFound(error: unknown): boolean {
  return error instanceof Error && /tenant not found/i.test(error.message);
}
