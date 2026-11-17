import { clearAccessToken, getAccessToken } from "./access-token";
import { ApiError, isUnauthenticated, toApiError } from "./api-client";
import { readServerSentEvents, type SseMessage } from "./sse";

export interface StreamClientOptions {
  /** Includes the version prefix, for example `http://localhost:3002/api/v1`. */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  /** Read on every call; when it returns a token the request carries `Authorization: Bearer`. */
  getToken?: () => string | null;
  /** Runs when a response is 401 `UNAUTHENTICATED`, before the error is thrown. */
  onUnauthenticated?: () => void;
}

export interface StreamRequest {
  /** Aborting it closes the connection (the server stops calling the model). */
  signal?: AbortSignal;
}

export interface StreamClient {
  /**
   * POSTs JSON and yields the Server-Sent Events of the answer. A non-2xx response throws the
   * same typed `ApiError` as `apiClient` (and a 401 drops the token); a network failure, before
   * or during the stream, throws `ApiError` with status 0 and code `NETWORK_ERROR`. An abort
   * throws the original `AbortError`.
   */
  post(path: string, body: unknown, request?: StreamRequest): AsyncGenerator<SseMessage>;
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}

const NETWORK_FAILURE = () => new ApiError(0, "NETWORK_ERROR", "Could not reach the server.");

export function createStreamClient({
  baseUrl,
  fetch: fetcher,
  getToken,
  onUnauthenticated,
}: StreamClientOptions): StreamClient {
  const root = baseUrl.replace(/\/+$/, "");

  async function* post(
    path: string,
    body: unknown,
    { signal }: StreamRequest = {},
  ): AsyncGenerator<SseMessage> {
    // Resolved on each call so tests (and polyfills) can replace the global fetch.
    const send = fetcher ?? globalThis.fetch;
    const token = getToken?.() ?? null;
    const headers: Record<string, string> = {
      accept: "text/event-stream",
      "content-type": "application/json",
    };

    if (token !== null) {
      headers.authorization = `Bearer ${token}`;
    }

    let response: Response;

    try {
      response = await send(`${root}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw isAbortError(error) ? error : NETWORK_FAILURE();
    }

    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      const failure = toApiError(response.status, payload);

      if (isUnauthenticated(failure)) {
        onUnauthenticated?.();
      }

      throw failure;
    }

    if (response.body === null) {
      throw NETWORK_FAILURE();
    }

    try {
      yield* readServerSentEvents(response.body);
    } catch (error) {
      throw isAbortError(error) ? error : NETWORK_FAILURE();
    }
  }

  return { post };
}

/** Default client: same base URL and token handling as `apiClient`. */
export const streamClient = createStreamClient({
  baseUrl: `${import.meta.env.VITE_API_URL ?? "http://localhost:3002"}/api/v1`,
  getToken: getAccessToken,
  onUnauthenticated: clearAccessToken,
});
