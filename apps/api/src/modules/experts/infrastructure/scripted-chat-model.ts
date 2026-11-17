import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";

/** The question that makes the scripted model fail (after the retry the answer fails for good). */
export const SCRIPTED_FAIL_MARKER = "[fail]";
/** The question that makes the scripted model answer slowly, so a test can press Stop. */
export const SCRIPTED_SLOW_MARKER = "[slow]";

export const SCRIPTED_ANSWER = "This is a scripted answer from the test model.";

const FAST_DELAY_MS = 5;
const SLOW_DELAY_MS = 150;
const SLOW_PIECES = 400;

function lastUserText(messages: readonly BaseMessage[]): string {
  const last = [...messages].reverse().find((message) => message.type === "human");

  return typeof last?.content === "string" ? last.content : "";
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("aborted"));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A chat model that never touches the network, selected by `NODE_ENV=test` (like the e-mail
 * `capture` provider). It answers a fixed text in small pieces, fails on `[fail]` and answers
 * slowly on `[slow]`, honoring the abort signal. The real graph runs on top of it, so the
 * automated tests and the E2E exercise LangGraph without OpenAI.
 */
export class ScriptedChatModel extends BaseChatModel {
  _llmType(): string {
    return "scripted";
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    let text = "";

    for await (const chunk of this._streamResponseChunks(messages, options, runManager)) {
      text += chunk.text;
    }

    return { generations: [{ text, message: new AIMessage(text) }] };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const question = lastUserText(messages);

    if (question.includes(SCRIPTED_FAIL_MARKER)) {
      throw new Error("scripted failure");
    }

    const slow = question.includes(SCRIPTED_SLOW_MARKER);
    const pieces = slow
      ? Array.from({ length: SLOW_PIECES }, (_, index) => `part ${index + 1} `)
      : SCRIPTED_ANSWER.split(/(?<= )/);

    for (const piece of pieces) {
      await sleep(slow ? SLOW_DELAY_MS : FAST_DELAY_MS, options.signal);

      const chunk = new ChatGenerationChunk({
        text: piece,
        message: new AIMessageChunk({ content: piece }),
      });

      yield chunk;
      await runManager?.handleLLMNewToken(piece);
    }

    yield new ChatGenerationChunk({
      text: "",
      message: new AIMessageChunk({
        content: "",
        usage_metadata: {
          input_tokens: 12,
          output_tokens: pieces.length,
          total_tokens: 12 + pieces.length,
        },
      }),
    });
  }
}
