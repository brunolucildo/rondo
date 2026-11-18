import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AvatarCharacter, buildPrompt } from "./characters.ts";
import { type ImageClient, ImageGenerationError } from "./image-client.ts";
import { normalizeAvatar, type NormalizeOptions } from "./normalize.ts";

export const MANIFEST_FILE = "manifest.json";
export const IMAGE_TIMEOUT_MS = 60_000;
/** One try plus one new try. */
const MAX_ATTEMPTS = 2;

export interface GenerateOptions {
  characters: readonly AvatarCharacter[];
  client: ImageClient;
  /** Folder of the PNG files and of the manifest. */
  outDir: string;
  model: string;
  size: string;
  force: boolean;
  now?: () => Date;
  timeoutMs?: number;
  normalize?: NormalizeOptions;
  /** Aborts the whole run (Ctrl+C): no file is left half written. */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export type AvatarOutcome =
  | { id: string; status: "generated"; bytes: number }
  | { id: string; status: "skipped"; reason: string }
  | { id: string; status: "failed"; reason: string };

export interface ManifestEntry {
  file: string;
  model: string;
  size: string;
  generatedAt: string;
  /** SHA-256 of the prompt that made the picture. */
  promptHash: string;
}

export interface Manifest {
  avatars: Record<string, ManifestEntry>;
}

export function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);

    return true;
  } catch {
    return false;
  }
}

/** Writes to a temporary file and renames it, so the target is whole or absent. */
async function writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;

  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readManifest(path: string): Promise<Manifest> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const avatars = (parsed as Partial<Manifest> | null)?.avatars;

    return { avatars: typeof avatars === "object" && avatars !== null ? avatars : {} };
  } catch {
    return { avatars: {} };
  }
}

async function requestPicture(
  options: GenerateOptions,
  prompt: string,
  attemptLog: (attempt: number, reason: string) => void,
): Promise<Uint8Array> {
  const { client, model, size, signal, timeoutMs = IMAGE_TIMEOUT_MS } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const timeout = AbortSignal.timeout(timeoutMs);

    try {
      return await client.generate({
        prompt,
        model,
        size,
        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
      });
    } catch (error) {
      lastError = error;

      if (signal?.aborted === true) {
        throw new Error("Interrupted.");
      }

      const retryable = error instanceof ImageGenerationError && error.retryable;

      if (!retryable || attempt === MAX_ATTEMPTS) {
        break;
      }

      attemptLog(attempt, error instanceof Error ? error.message : "unknown error");
    }
  }

  throw lastError;
}

/**
 * Generates the avatars one at a time. A failure (API error, content policy, timeout, a picture
 * that cannot be normalized) is recorded for that expert and the run goes on; nothing is written
 * for a failed expert. Existing files are kept unless `force` is set.
 */
export async function generateAvatars(options: GenerateOptions): Promise<AvatarOutcome[]> {
  const { characters, outDir, model, size, force, signal, now = () => new Date() } = options;
  const log = options.log ?? (() => undefined);
  const manifestPath = join(outDir, MANIFEST_FILE);
  const outcomes: AvatarOutcome[] = [];

  await mkdir(outDir, { recursive: true });

  for (const character of characters) {
    if (signal?.aborted === true) {
      outcomes.push({ id: character.id, status: "failed", reason: "Interrupted." });
      continue;
    }

    const file = `${character.id}.png`;
    const target = join(outDir, file);

    if (!force && (await exists(target))) {
      outcomes.push({
        id: character.id,
        status: "skipped",
        reason: "file exists (use --force to regenerate)",
      });
      continue;
    }

    const prompt = buildPrompt(character);

    log(`${character.id}: generating with ${model}...`);

    try {
      const raw = await requestPicture(options, prompt, (attempt, reason) =>
        log(`${character.id}: attempt ${attempt} failed (${reason}); trying once more.`),
      );
      const avatar = normalizeAvatar(raw, options.normalize);

      await writeAtomic(target, avatar);

      const manifest = await readManifest(manifestPath);

      manifest.avatars[character.id] = {
        file,
        model,
        size,
        generatedAt: now().toISOString(),
        promptHash: promptHash(prompt),
      };
      await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      outcomes.push({ id: character.id, status: "generated", bytes: avatar.byteLength });
    } catch (error) {
      const reason =
        error instanceof ImageGenerationError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : "unknown error";

      outcomes.push({ id: character.id, status: "failed", reason });
    }
  }

  return outcomes;
}
