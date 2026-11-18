import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { VisionRefusedError, VisionUnavailableError } from "../domain/connection-errors";
import type { ImageDescriber, ImageToDescribe } from "../domain/connection-ports";

/** HTTP statuses that say the image itself is the problem (bad request, content policy): no retry. */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 422]);

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const { status } = error as { status: unknown };

    return typeof status === "number" ? status : undefined;
  }

  return undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block: unknown) =>
        typeof block === "object" && block !== null && "text" in block
          ? String((block as { text: unknown }).text)
          : "",
      )
      .join("");
  }

  return "";
}

/**
 * `ImageDescriber` over a LangChain chat model with vision (`gpt-4o-mini` through
 * `@langchain/openai`, built by the module). The instruction goes as the system message and the
 * image as a data URL in the user message; nothing is logged and the bytes are not kept.
 *
 * A refusal (the `refusal` field, `content_filter`, a 400 or 422) is `VisionRefusedError`; every
 * other failure (429, 5xx, network, abort) is `VisionUnavailableError`, which the extractor may retry.
 */
export class LangChainImageDescriber implements ImageDescriber {
  constructor(private readonly model: BaseChatModel) {}

  async describe(image: ImageToDescribe, signal: AbortSignal): Promise<string> {
    const dataUrl = `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;

    try {
      const answer = await this.model.invoke(
        [
          new SystemMessage(image.instruction),
          new HumanMessage({
            content: [
              { type: "text", text: "Convert this image to text." },
              { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
            ],
          }),
        ],
        { signal },
      );
      const refusal = (answer.additional_kwargs as Record<string, unknown>).refusal;
      const finishReason = (answer.response_metadata as Record<string, unknown>).finish_reason;

      if ((typeof refusal === "string" && refusal !== "") || finishReason === "content_filter") {
        throw new VisionRefusedError();
      }

      return textOf(answer.content);
    } catch (error) {
      if (error instanceof VisionRefusedError) {
        throw error;
      }

      const status = statusOf(error);

      throw status !== undefined && REFUSAL_STATUSES.has(status)
        ? new VisionRefusedError()
        : new VisionUnavailableError();
    }
  }
}
