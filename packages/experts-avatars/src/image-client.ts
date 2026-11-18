export interface ImageRequest {
  prompt: string;
  model: string;
  /** Requested size, for example `1024x1024`. */
  size: string;
  signal: AbortSignal;
}

/** Turns a prompt into the bytes of a PNG. The only door to the network; tests use a fake. */
export interface ImageClient {
  generate(request: ImageRequest): Promise<Uint8Array>;
}

export type ImageFailureCode = "blocked" | "timeout" | "api" | "invalid_response";

export class ImageGenerationError extends Error {
  readonly code: ImageFailureCode;
  /** True when trying once more can work (timeout, rate limit, server error). */
  readonly retryable: boolean;

  constructor(code: ImageFailureCode, message: string, retryable = false) {
    super(message);
    this.name = "ImageGenerationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Error codes the Image API uses when its content policy refuses a prompt. */
const BLOCKED_CODES = new Set(["content_policy_violation", "moderation_blocked"]);

interface ApiErrorBody {
  error?: { code?: unknown; message?: unknown; type?: unknown };
}

interface ApiImageBody {
  data?: Array<{ b64_json?: unknown }>;
}

export interface OpenAiImageClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function failureFor(status: number, body: unknown, apiKey: string): ImageGenerationError {
  const error = (body as ApiErrorBody | null)?.error;
  const code = typeof error?.code === "string" ? error.code : "";
  const message =
    typeof error?.message === "string"
      ? error.message.replaceAll(apiKey, "[redacted]").slice(0, 300)
      : "no message from the API";

  if (BLOCKED_CODES.has(code) || /safety system|content policy/i.test(message)) {
    return new ImageGenerationError("blocked", `Blocked by the content policy: ${message}`);
  }

  return new ImageGenerationError(
    "api",
    `Image API answered ${status}: ${message}`,
    status === 429 || status >= 500,
  );
}

/**
 * `POST /v1/images/generations`. GPT image models answer with the picture as base64 in
 * `data[0].b64_json`, so no `response_format` is sent. The key goes only in the header and is never
 * printed.
 */
export function createOpenAiImageClient(options: OpenAiImageClientOptions): ImageClient {
  const { apiKey, baseUrl = OPENAI_BASE_URL, fetchImpl = fetch } = options;

  return {
    async generate({ prompt, model, size, signal }) {
      let response: Response;

      try {
        response = await fetchImpl(`${baseUrl}/images/generations`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, prompt, size, n: 1 }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) {
          throw new ImageGenerationError("timeout", "The Image API did not answer in time.", true);
        }

        throw new ImageGenerationError(
          "api",
          `The Image API could not be reached: ${error instanceof Error ? error.message : "unknown error"}`,
          true,
        );
      }

      const body = await readJson(response);

      if (!response.ok) {
        throw failureFor(response.status, body, apiKey);
      }

      const encoded = (body as ApiImageBody | null)?.data?.[0]?.b64_json;

      if (typeof encoded !== "string" || encoded === "") {
        throw new ImageGenerationError("invalid_response", "The Image API returned no picture.");
      }

      return new Uint8Array(Buffer.from(encoded, "base64"));
    },
  };
}
