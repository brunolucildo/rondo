import { getAccessToken, clearAccessToken } from "./access-token";
import { ApiError, isUnauthenticated, toApiError } from "./api-client";

export interface UploadClientOptions {
  /** Includes the version prefix, for example `http://localhost:3002/api/v1`. */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  getToken?: () => string | null;
  onUnauthenticated?: () => void;
}

export interface UploadClient {
  /**
   * POSTs one file as `multipart/form-data` (field `file`) and returns the JSON answer. A non-2xx
   * response throws the same typed `ApiError` as `apiClient`; a network failure throws `ApiError`
   * with status 0 and code `NETWORK_ERROR`. The browser sets the multipart boundary: no
   * `content-type` header is written here.
   */
  postFile<TResponse>(path: string, file: File): Promise<TResponse>;
}

export function createUploadClient({
  baseUrl,
  fetch: fetcher,
  getToken,
  onUnauthenticated,
}: UploadClientOptions): UploadClient {
  const root = baseUrl.replace(/\/+$/, "");

  return {
    async postFile<TResponse>(path: string, file: File): Promise<TResponse> {
      // Resolved on each call so tests can replace the global fetch.
      const send = fetcher ?? globalThis.fetch;
      const token = getToken?.() ?? null;
      const body = new FormData();
      let response: Response;

      body.append("file", file, file.name);

      try {
        response = await send(`${root}${path}`, {
          method: "POST",
          headers: {
            accept: "application/json",
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          },
          body,
        });
      } catch {
        throw new ApiError(0, "NETWORK_ERROR", "Could not reach the server.");
      }

      const payload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        const failure = toApiError(response.status, payload);

        if (isUnauthenticated(failure)) {
          onUnauthenticated?.();
        }

        throw failure;
      }

      return payload as TResponse;
    },
  };
}

/** Default client: `VITE_API_URL` (public) plus the `/api/v1` prefix. */
export const uploadClient = createUploadClient({
  baseUrl: `${import.meta.env.VITE_API_URL ?? "http://localhost:3002"}/api/v1`,
  getToken: getAccessToken,
  onUnauthenticated: clearAccessToken,
});
