/** Embedding model whose vectors the index stores. Changing it changes the dimension: reindex. */
export const EMBEDDING_MODEL = "text-embedding-3-small";

/** Dimension of `text-embedding-3-small`. The index refuses any other vector length. */
export const EMBEDDING_DIMENSIONS = 1536;

/** Texts sent to the embeddings provider in one call. */
export const EMBEDDINGS_BATCH_SIZE = 96;

/** Most hits one `search` can return. */
export const MAX_SEARCH_LIMIT = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * Weaviate tenant of a user: `u_` plus the UUID without hyphens (34 characters, inside the
 * `[A-Za-z0-9_-]{1,64}` the server accepts). Derived, never stored, and never logged: it is the
 * isolation boundary, so it identifies a user.
 */
export function tenantNameOf(userId: string): string {
  return `u_${userId.toLowerCase().replaceAll("-", "")}`;
}
