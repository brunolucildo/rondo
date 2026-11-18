import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { describe, expect, it } from "vitest";
import { VisionRefusedError, VisionUnavailableError } from "../domain/connection-errors";
import { VISION_INSTRUCTION } from "../domain/vision-instruction";
import { buildPng } from "../testing";
import { LangChainImageDescriber } from "./langchain-image-describer";

/** A chat model that never touches the network: it records the messages and answers as told. */
class StubModel extends BaseChatModel {
  seen: BaseMessage[] = [];

  constructor(private readonly reply: () => AIMessage) {
    super({});
  }

  _llmType(): string {
    return "stub";
  }

  _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen = messages;

    const message = this.reply();

    return Promise.resolve({ generations: [{ message, text: String(message.content) }] });
  }
}

const image = (bytes = buildPng()) => ({
  bytes,
  mimeType: "image/png" as const,
  instruction: VISION_INSTRUCTION,
});
const signal = () => new AbortController().signal;

function failing(error: unknown) {
  return new StubModel(() => {
    throw error;
  });
}

describe("LangChainImageDescriber", () => {
  it("sends the instruction as the system message and the image as a data URL, and returns the text", async () => {
    const model = new StubModel(() => new AIMessage("DESCRIPTION: a table.\nTEXT: 3-1"));
    const bytes = buildPng({ note: "marker" });
    const answer = await new LangChainImageDescriber(model).describe(image(bytes), signal());

    expect(answer).toBe("DESCRIPTION: a table.\nTEXT: 3-1");
    expect(model.seen[0]?.content).toBe(VISION_INSTRUCTION);

    const content = model.seen[1]?.content;

    expect(Array.isArray(content)).toBe(true);
    expect(JSON.stringify(content)).toContain(
      `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
    );
  });

  it("joins the text blocks of a structured answer", async () => {
    const model = new StubModel(
      () =>
        new AIMessage({
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        }),
    );

    expect(await new LangChainImageDescriber(model).describe(image(), signal())).toBe("ab");
  });

  it("is a refusal when the provider sets the refusal field or filters the content", async () => {
    const refusal = new StubModel(
      () =>
        new AIMessage({
          content: "",
          additional_kwargs: { refusal: "I cannot help with that." },
        }),
    );
    const filtered = new StubModel(
      () =>
        new AIMessage({
          content: "partial",
          response_metadata: { finish_reason: "content_filter" },
        }),
    );

    await expect(
      new LangChainImageDescriber(refusal).describe(image(), signal()),
    ).rejects.toBeInstanceOf(VisionRefusedError);
    await expect(
      new LangChainImageDescriber(filtered).describe(image(), signal()),
    ).rejects.toBeInstanceOf(VisionRefusedError);
  });

  it("is a refusal for a 400 or 422 and unavailable for 429, 5xx and a network failure", async () => {
    const outcome = async (error: unknown) =>
      new LangChainImageDescriber(failing(error)).describe(image(), signal()).then(
        () => "ok",
        (thrown: unknown) => thrown,
      );

    expect(await outcome(Object.assign(new Error("bad"), { status: 400 }))).toBeInstanceOf(
      VisionRefusedError,
    );
    expect(await outcome(Object.assign(new Error("bad"), { status: 422 }))).toBeInstanceOf(
      VisionRefusedError,
    );
    expect(await outcome(Object.assign(new Error("slow"), { status: 429 }))).toBeInstanceOf(
      VisionUnavailableError,
    );
    expect(await outcome(Object.assign(new Error("boom"), { status: 503 }))).toBeInstanceOf(
      VisionUnavailableError,
    );
    expect(await outcome(new Error("ECONNRESET"))).toBeInstanceOf(VisionUnavailableError);
  });

  it("never puts the provider message in the error it throws", async () => {
    const error = await new LangChainImageDescriber(
      failing(Object.assign(new Error("secret provider detail SENTINEL"), { status: 500 })),
    )
      .describe(image(), signal())
      .catch((thrown: unknown) => thrown);

    expect((error as Error).message).not.toContain("SENTINEL");
  });
});
