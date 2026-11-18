import { createPartFromUri, createUserContent, FileState, GoogleGenAI } from "@google/genai";
import type { GeminiClient, GeminiFile, GeminiGeneration } from "./gemini-media-understanding";

/** Reasons the provider gives when it refuses the content by its policy. */
const BLOCKING_FINISH_REASONS: ReadonlySet<string> = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
]);

function toFile(file: {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
}): GeminiFile {
  if (file.name === undefined || file.uri === undefined) {
    throw new Error("The provider returned an incomplete file.");
  }

  return {
    name: file.name,
    uri: file.uri,
    mimeType: file.mimeType ?? "application/octet-stream",
    state:
      file.state === FileState.PROCESSING
        ? "PROCESSING"
        : file.state === FileState.FAILED
          ? "FAILED"
          : "ACTIVE",
  };
}

/**
 * `GeminiClient` over the official `@google/genai` SDK (spec 0028). The file is uploaded from
 * memory (a `Blob`), never from disk. The SDK's own retries are off (`attempts: 1`): the adapter
 * decides when to try again. `GEMINI_API_KEY` stays on the server.
 */
export function createGeminiClient(apiKey: string, model: string): GeminiClient {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });

  return {
    async uploadFile(bytes, mimeType, signal) {
      const blob = new Blob([bytes as BlobPart], { type: mimeType });

      return toFile(
        await ai.files.upload({ file: blob, config: { mimeType, abortSignal: signal } }),
      );
    },
    async getFile(name, signal) {
      return toFile(await ai.files.get({ name, config: { abortSignal: signal } }));
    },
    async generate(file, instruction, signal): Promise<GeminiGeneration> {
      const response = await ai.models.generateContent({
        model,
        contents: createUserContent([createPartFromUri(file.uri, file.mimeType), instruction]),
        config: { temperature: 0, abortSignal: signal },
      });
      const finishReason = response.candidates?.[0]?.finishReason;

      return {
        text: response.text,
        blocked:
          response.promptFeedback?.blockReason !== undefined ||
          (finishReason !== undefined && BLOCKING_FINISH_REASONS.has(finishReason)),
      };
    },
    async deleteFile(name) {
      await ai.files.delete({ name });
    },
  };
}
