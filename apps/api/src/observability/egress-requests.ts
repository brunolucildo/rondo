/**
 * Requests the API makes to links a user connected (spec 0027) are marked with this symbol and
 * left out of the HTTP instrumentation: its client spans and `http.client.*` metrics carry the
 * host, the path and the port, and the query of such a link can hold a secret. The ingestion
 * telemetry (`connection.ingestions`, `url_fetch.*`) says what happened without any of that.
 */
export const EGRESS_REQUEST = Symbol.for("rondo.egress-request");

/** `ignoreOutgoingRequestHook` of the HTTP instrumentation: true for the requests marked above. */
export function isEgressRequest(options: unknown): boolean {
  return (
    typeof options === "object" &&
    options !== null &&
    (options as Record<symbol, unknown>)[EGRESS_REQUEST] === true
  );
}
