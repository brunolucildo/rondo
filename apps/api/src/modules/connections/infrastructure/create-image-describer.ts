import { ChatOpenAI } from "@langchain/openai";
import type { ImageDescriber } from "../domain/connection-ports";
import type { VisionConfig } from "../domain/vision-config";
import { InstrumentedImageDescriber } from "./instrumented-image-describer";
import { LangChainImageDescriber } from "./langchain-image-describer";
import { ScriptedImageDescriber } from "./scripted-image-describer";
import { UnavailableImageDescriber } from "./unavailable-image-describer";

/** Output tokens that fit the 4,000 characters the extractor keeps, with room for other scripts. */
const MAX_OUTPUT_TOKENS = 2000;

/**
 * Builds the one vision model the environment selected; the others are never constructed. Every
 * call is timed and recorded by outcome (no content).
 */
export function createImageDescriber(config: VisionConfig): ImageDescriber {
  return new InstrumentedImageDescriber(select(config));
}

function select(config: VisionConfig): ImageDescriber {
  switch (config.provider) {
    case "openai":
      return new LangChainImageDescriber(
        new ChatOpenAI({
          model: config.model,
          apiKey: config.apiKey,
          temperature: 0,
          maxTokens: MAX_OUTPUT_TOKENS,
          // The extractor owns the attempts and the timeout of each one.
          maxRetries: 0,
        }),
      );
    case "fake":
      return new ScriptedImageDescriber();
    case "unavailable":
      return new UnavailableImageDescriber();
  }
}
