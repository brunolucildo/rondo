import { VisionRefusedError, VisionUnavailableError } from "../domain/connection-errors";
import type { ImageDescriber, ImageToDescribe } from "../domain/connection-ports";
import { IMAGE_NO_CONTENT_MARKER } from "../domain/vision-instruction";

/** Markers a test puts inside the bytes of an image (as plain text) to script the answer. */
export const VISION_BLANK_MARKER = "[vision-blank]";
export const VISION_REFUSE_MARKER = "[vision-refuse]";
export const VISION_UNAVAILABLE_MARKER = "[vision-unavailable]";
export const VISION_LONG_MARKER = "[vision-long]";
/** `[vision-text:...]` sets the transcribed text (up to the closing bracket). */
const TEXT_MARKER = /\[vision-text:([^\]]*)\]/;

export const SCRIPTED_VISION_TEXT = "Squad sheet. Midfield: Alves, Costa and Souza.";

/**
 * A vision model that never touches the network, selected by `NODE_ENV=test` (like the scripted
 * chat model). It reads the markers above from the bytes: blank, refusal, unavailable, a very long
 * answer, or the exact text to return; otherwise a fixed description. It counts its calls and
 * keeps the last instruction so a test can check what the model was told.
 */
export class ScriptedImageDescriber implements ImageDescriber {
  calls = 0;
  lastInstruction: string | null = null;

  describe(image: ImageToDescribe, signal: AbortSignal): Promise<string> {
    this.calls += 1;
    this.lastInstruction = image.instruction;

    if (signal.aborted) {
      return Promise.reject(new VisionUnavailableError());
    }

    const marked = Buffer.from(image.bytes).toString("latin1");

    if (marked.includes(VISION_BLANK_MARKER)) {
      return Promise.resolve(IMAGE_NO_CONTENT_MARKER);
    }

    if (marked.includes(VISION_REFUSE_MARKER)) {
      return Promise.reject(new VisionRefusedError());
    }

    if (marked.includes(VISION_UNAVAILABLE_MARKER)) {
      return Promise.reject(new VisionUnavailableError());
    }

    if (marked.includes(VISION_LONG_MARKER)) {
      return Promise.resolve("x".repeat(10_000));
    }

    const text = TEXT_MARKER.exec(marked)?.[1] ?? SCRIPTED_VISION_TEXT;

    return Promise.resolve(`DESCRIPTION: a scripted image.\nTEXT: ${text}`);
  }
}
