export const DEFAULT_VISION_MODEL = "gpt-4o-mini";

/**
 * Which vision model describes the images. `fake` is only for automated tests (`NODE_ENV=test`, like
 * the scripted chat model and the e-mail `capture` provider) and `unavailable` means no key: the API
 * boots and an image connection fails with `PROCESSING_UNAVAILABLE`.
 */
export type VisionConfig =
  | { provider: "openai"; apiKey: string; model: string }
  | { provider: "fake" }
  | { provider: "unavailable" };

/**
 * The vision model is a function of the environment: `test` uses the scripted fake (never the
 * network); anything else uses OpenAI when `OPENAI_API_KEY` is set (the model is `gpt-4o-mini`
 * unless `OPENAI_VISION_MODEL` says otherwise). The key is optional at boot and is never echoed.
 */
export function parseVisionConfig(
  env: Record<string, string | undefined>,
  nodeEnv: string,
): VisionConfig {
  if (nodeEnv === "test") {
    return { provider: "fake" };
  }

  const apiKey = env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    return { provider: "unavailable" };
  }

  return {
    provider: "openai",
    apiKey,
    model: env.OPENAI_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL,
  };
}
