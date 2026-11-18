export const DEFAULT_CHAT_MODEL = "gpt-4o-mini";

/**
 * Which chat model answers. `fake` is only for automated tests (`NODE_ENV=test`, like the e-mail
 * `capture` provider) and `unavailable` means no key: the API boots and only sending answers 503.
 */
export type ExpertChatConfig =
  | { provider: "openai"; apiKey: string; model: string }
  | { provider: "fake" }
  | { provider: "unavailable" };

/**
 * The chat model is a function of the environment: `test` uses the scripted fake (never the
 * network), everything else, `production` included, uses OpenAI when `OPENAI_API_KEY` is set.
 * The key is optional at boot and is never echoed.
 */
export function parseExpertChatConfig(
  env: Record<string, string | undefined>,
  nodeEnv: string,
): ExpertChatConfig {
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
    model: env.OPENAI_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL,
  };
}
