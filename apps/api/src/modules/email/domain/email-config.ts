import type { EmailAddress } from "./email-message";

export type EmailProviderName = "mailtrap" | "resend" | "capture";

/** `NODE_ENV` is optional: when it is missing or blank the API behaves as `dev`. */
export const DEFAULT_NODE_ENV = "dev";

export type EmailConfig =
  | { provider: "capture"; from: EmailAddress }
  | { provider: "mailtrap"; from: EmailAddress; apiToken: string; inboxId: string }
  | { provider: "resend"; from: EmailAddress; apiKey: string };

const ADDRESS_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const NAMED_ADDRESS_PATTERN = /^\s*"?([^"<>]+?)"?\s*<([^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+)>\s*$/;

/** Accepts `user@host` or `Display Name <user@host>`. */
export function parseEmailFrom(value: string | undefined): EmailAddress {
  const trimmed = value?.trim() ?? "";

  if (ADDRESS_PATTERN.test(trimmed)) {
    return { address: trimmed };
  }

  const named = NAMED_ADDRESS_PATTERN.exec(trimmed);

  if (named?.[1] && named[2]) {
    return { name: named[1].trim(), address: named[2] };
  }

  throw new Error(
    'EMAIL_FROM must be an e-mail address, optionally with a name, for example "Rondo <no-reply@example.com>".',
  );
}

/** The effective environment name: trimmed, lower-cased, `dev` when absent or blank. */
export function resolveNodeEnv(env: Record<string, string | undefined>): string {
  const value = env.NODE_ENV?.trim().toLowerCase();

  return value ? value : DEFAULT_NODE_ENV;
}

/**
 * The e-mail provider is a function of the environment: production sends through Resend,
 * `test` captures in memory, everything else (including `dev`) uses the Mailtrap sandbox.
 */
export function selectEmailProvider(nodeEnv: string): EmailProviderName {
  if (nodeEnv === "production") {
    return "resend";
  }

  return nodeEnv === "test" ? "capture" : "mailtrap";
}

function requireVariable(
  env: Record<string, string | undefined>,
  name: string,
  provider: EmailProviderName,
  nodeEnv: string,
): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} is required when the e-mail provider is ${provider} (NODE_ENV is "${nodeEnv}").`,
    );
  }

  return value;
}

/**
 * Validates the e-mail variables at boot. The provider comes from `NODE_ENV`; errors name
 * the variable and never echo credential values.
 */
export function parseEmailConfig(env: Record<string, string | undefined>): EmailConfig {
  const nodeEnv = resolveNodeEnv(env);
  const provider = selectEmailProvider(nodeEnv);
  const from = parseEmailFrom(env.EMAIL_FROM);

  switch (provider) {
    case "resend":
      return {
        provider,
        from,
        apiKey: requireVariable(env, "RESEND_API_KEY", provider, nodeEnv),
      };
    case "mailtrap": {
      const inboxId = requireVariable(env, "MAILTRAP_INBOX_ID", provider, nodeEnv);

      if (!/^\d+$/.test(inboxId)) {
        throw new Error("MAILTRAP_INBOX_ID must be the numeric id of the Mailtrap inbox.");
      }

      return {
        provider,
        from,
        apiToken: requireVariable(env, "MAILTRAP_API_TOKEN", provider, nodeEnv),
        inboxId,
      };
    }
    case "capture":
      return { provider, from };
  }
}
