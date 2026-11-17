import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  END,
  type LangGraphRunnableConfig,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { ModelMessage } from "../domain/expert-conversation";
import { ExpertModelError } from "../domain/expert-errors";
import type {
  ExpertOrchestrator,
  OrchestratorEvent,
  OrchestratorInput,
} from "../domain/expert-ports";

function toLangChainMessage(message: ModelMessage): BaseMessage {
  switch (message.role) {
    case "system":
      return new SystemMessage(message.content);
    case "user":
      return new HumanMessage(message.content);
    case "assistant":
      return new AIMessage(message.content);
  }
}

/** Text of a streamed chunk, whether the provider sends a string or content blocks. */
function textOf(chunk: AIMessageChunk): string {
  const { content } = chunk;

  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

function isOrchestratorEvent(value: unknown): value is OrchestratorEvent {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  if (value.type === "text") {
    return "text" in value && typeof value.text === "string";
  }

  return value.type === "usage" && "usage" in value;
}

/**
 * Turns a provider failure into the domain error. 429, 408, 5xx and failures without an HTTP
 * status (network, timeout) are worth one more attempt; other 4xx (bad key, bad request) are not.
 * The provider's own message is dropped: it can echo parts of the prompt.
 */
export function toExpertModelError(error: unknown): ExpertModelError {
  if (error instanceof ExpertModelError) {
    return error;
  }

  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : undefined;

  if (typeof status !== "number") {
    return new ExpertModelError(true);
  }

  return new ExpertModelError(status === 408 || status === 429 || status >= 500);
}

/**
 * The expert's LangGraph.js graph: `START → respond → END`. The `respond` node streams the chat
 * model and writes each piece to the `custom` stream, which is the contract with the use case
 * (`text` and `usage` events). Later specs add nodes (retrieval, citations) around `respond`
 * without changing that contract. The model is injected: OpenAI in production, a fake in tests.
 */
export class LangGraphExpertOrchestrator implements ExpertOrchestrator {
  readonly available = true;
  private readonly graph;

  constructor(model: BaseChatModel) {
    const respond = async (
      state: typeof MessagesAnnotation.State,
      config: LangGraphRunnableConfig,
    ) => {
      let answer: AIMessageChunk | undefined;

      for await (const chunk of await model.stream(state.messages, config)) {
        answer = answer === undefined ? chunk : answer.concat(chunk);

        const text = textOf(chunk);

        if (text !== "") {
          config.writer?.({ type: "text", text } satisfies OrchestratorEvent);
        }
      }

      const usage = answer?.usage_metadata;

      if (usage !== undefined) {
        config.writer?.({
          type: "usage",
          usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
        } satisfies OrchestratorEvent);
      }

      return { messages: answer === undefined ? [] : [answer] };
    };

    this.graph = new StateGraph(MessagesAnnotation)
      .addNode("respond", respond)
      .addEdge(START, "respond")
      .addEdge("respond", END)
      .compile();
  }

  async *answer({ messages, signal }: OrchestratorInput): AsyncGenerator<OrchestratorEvent> {
    try {
      const stream = await this.graph.stream(
        { messages: messages.map(toLangChainMessage) },
        { streamMode: "custom", signal },
      );

      for await (const event of stream) {
        if (isOrchestratorEvent(event)) {
          yield event;
        }
      }
    } catch (error) {
      throw toExpertModelError(error);
    }
  }
}
