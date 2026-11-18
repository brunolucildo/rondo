import { fileURLToPath } from "node:url";
import { AVATAR_CHARACTERS, findCharacter } from "./characters.ts";
import { generateAvatars } from "./generate.ts";
import { createOpenAiImageClient, type ImageClient } from "./image-client.ts";

/** Where the PNGs and the manifest live: the assets of the app (Vite hashes the names). */
export const DEFAULT_OUT_DIR = fileURLToPath(
  new URL("../../../apps/app/src/assets/experts", import.meta.url),
);

export const DEFAULT_MODEL = "gpt-image-2";
export const DEFAULT_SIZE = "1024x1024";

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Builds the network client; only called after the arguments and the key are valid. */
  createClient?: (apiKey: string) => ImageClient;
  outDir?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const HELP = [
  "Generates the pixel art avatars of the experts with the OpenAI Image API (once, by hand).",
  "",
  "Usage:",
  "  bun run experts:avatars -- --expert <id> [--force]   one expert",
  "  bun run experts:avatars -- --all [--force]           every expert (7 API calls)",
  "  bun run experts:avatars                              this help (no API call)",
  "",
  "Options:",
  "  --expert <id>  one of: " + AVATAR_CHARACTERS.map((character) => character.id).join(", "),
  "  --all          every expert, one at a time; review each result",
  "  --force        regenerate files that already exist (default: skip them)",
  "  --help         this help",
  "",
  "Environment:",
  "  OPENAI_API_KEY       required to call the API (never printed)",
  "  OPENAI_IMAGE_MODEL   model name (default: gpt-image-2)",
  "  OPENAI_IMAGE_SIZE    requested size (default: 1024x1024)",
  "",
  "Files go to apps/app/src/assets/experts/ with a manifest.json (model, date, prompt hash).",
  "Cost: one image per expert, so up to 7 calls for --all; check the current price on the OpenAI pricing page.",
].join("\n");

interface Parsed {
  help: boolean;
  all: boolean;
  force: boolean;
  expert: string | null;
  error: string | null;
}

function parseArgs(argv: readonly string[]): Parsed {
  const parsed: Parsed = { help: false, all: false, force: false, expert: null, error: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--all") {
      parsed.all = true;
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--expert") {
      const value = argv[i + 1];

      if (value === undefined || value.startsWith("--")) {
        parsed.error = "--expert needs an expert id.";
      } else {
        parsed.expert = value;
        i += 1;
      }
    } else if (arg !== "--") {
      parsed.error = `Unknown argument: ${arg}`;
    }
  }

  return parsed;
}

/** Returns the process exit code. Without a flag, or without a key, it never touches the network. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { env, out, err } = deps;
  const args = parseArgs(argv);

  if (args.error !== null) {
    err(`${args.error}\n\n${HELP}`);

    return 2;
  }

  if (args.help || (!args.all && args.expert === null && !args.force)) {
    out(HELP);

    return 0;
  }

  if (args.all === (args.expert !== null)) {
    err(`Choose exactly one of --expert <id> or --all.\n\n${HELP}`);

    return 2;
  }

  const characters = args.all
    ? AVATAR_CHARACTERS
    : [findCharacter(args.expert ?? "")].filter((character) => character !== undefined);

  if (characters.length === 0) {
    err(
      `Unknown expert "${args.expert}". Valid ids: ${AVATAR_CHARACTERS.map((c) => c.id).join(", ")}.`,
    );

    return 2;
  }

  const apiKey = env.OPENAI_API_KEY?.trim();

  if (apiKey === undefined || apiKey === "") {
    err(
      "OPENAI_API_KEY is not set. Define it in your environment (never commit it) and try again.",
    );

    return 1;
  }

  const model = env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_MODEL;
  const size = env.OPENAI_IMAGE_SIZE?.trim() || DEFAULT_SIZE;
  const client = (deps.createClient ?? ((key) => createOpenAiImageClient({ apiKey: key })))(apiKey);
  const outcomes = await generateAvatars({
    characters,
    client,
    outDir: deps.outDir ?? DEFAULT_OUT_DIR,
    model,
    size,
    force: args.force,
    signal: deps.signal,
    timeoutMs: deps.timeoutMs,
    log: out,
  });

  for (const outcome of outcomes) {
    if (outcome.status === "generated") {
      out(`${outcome.id}: generated (${outcome.bytes} bytes)`);
    } else if (outcome.status === "skipped") {
      out(`${outcome.id}: skipped, ${outcome.reason}`);
    } else {
      err(`${outcome.id}: FAILED, ${outcome.reason}`);
    }
  }

  const failed = outcomes.filter((outcome) => outcome.status === "failed").length;

  if (failed > 0) {
    err(
      `${failed} of ${outcomes.length} failed. The others were kept; run again for the missing ones.`,
    );

    return 1;
  }

  out("Review each picture before committing it (checklist in .docs/DESIGN.md).");

  return 0;
}
