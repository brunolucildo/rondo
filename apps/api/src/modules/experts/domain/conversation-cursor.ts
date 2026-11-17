const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The cursor of a page is opaque to the client: the id of the oldest message it has, in base64url.
 * The server never trusts it: it must decode to a UUID, and the repository only ever sends it to
 * Postgres as a bound parameter, scoped to the conversation of the session user.
 */
export function encodeCursor(messageId: string): string {
  return Buffer.from(messageId, "utf8").toString("base64url");
}

/** The message id inside a cursor, or `null` when it is not one this server produced. */
export function decodeCursor(cursor: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    return null;
  }

  const decoded = Buffer.from(cursor, "base64url").toString("utf8");

  return MESSAGE_ID.test(decoded) ? decoded : null;
}
