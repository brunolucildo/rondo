import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  Annotation,
  END,
  type LangGraphRunnableConfig,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { ModelMessage } from "../domain/expert-conversation";
import { ExpertKnowledgeUnavailableError, ExpertModelError } from "../domain/expert-errors";
import type {
  ExpertOrchestrator,
  KnowledgeRetriever,
  OrchestratorEvent,
  OrchestratorInput,
  RetrievalRequest,
} from "../domain/expert-ports";
import { applyGrounding, buildCitations, type Grounding } from "../domain/grounding";

/** The graph state: the typed messages, what to retrieve and what the retrieval found. */
const ExpertState = Annotation.Root({
  ...MessagesAnnotation.spec,
  retrieval: Annotation<RetrievalRequest | null>(),
  grounding: Annotation<Grounding | null>(),
});

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

/** A typed LangChain message back as a plain one (only `system`, `human` and `ai` exist here). */
function toModelMessage(message: BaseMessage): ModelMessage {
  const content = typeof message.content === "string" ? message.content : "";

  switch (message.type) {
    case "system":
      return { role: "system", content };
    case "ai":
      return { role: "assistant", content };
    default:
      return { role: "user", content };
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

  if (value.type === "citations") {
    return "citations" in value && Array.isArray(value.citations);
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
 * The expert's LangGraph.js graph: `START → retrieve → respond → END`.
 *
 * `retrieve` looks for chunks of the user's connected documents (a `KnowledgeRetriever`) and, as
 * soon as it ends, writes the server-built citations to the `custom` stream. It does nothing when
 * the request carries no retrieval (the user has no ready connection). `respond` adds the grounding
 * rules and the retrieved material, as data, to the system prompt, streams the chat model and
 * writes each piece to the `custom` stream. That stream is the contract with the use case (`text`,
 * `usage` and `citations` events). The model is injected: OpenAI in production, a fake in tests.
 * A failure of the retrieval is thrown as `ExpertKnowledgeUnavailableError`, never swallowed.
 */
export class LangGraphExpertOrchestrator implements ExpertOrchestrator {
  readonly available = true;
  private readonly graph;

  constructor(model: BaseChatModel, retriever?: KnowledgeRetriever) {
    const retrieve = async (
      state: typeof ExpertState.State,
      config: LangGraphRunnableConfig,
    ): Promise<{ grounding: Grounding | null }> => {
      const request = state.retrieval;

      if (request === null || request === undefined) {
        return { grounding: null };
      }

      if (retriever === undefined) {
        throw new ExpertKnowledgeUnavailableError();
      }

      const chunks = await retriever.retrieve(
        request,
        config.signal ?? new AbortController().signal,
      );

      config.writer?.({
        type: "citations",
        citations: buildCitations(chunks),
      } satisfies OrchestratorEvent);

      return { grounding: { chunks, scoped: request.connectionIds !== null } };
    };

    const respond = async (state: typeof ExpertState.State, config: LangGraphRunnableConfig) => {
      let answer: AIMessageChunk | undefined;
      const prompt =
        state.grounding === null || state.grounding === undefined
          ? state.messages
          : applyGrounding(state.messages.map(toModelMessage), state.grounding).map(
              toLangChainMessage,
            );

      for await (const chunk of await model.stream(prompt, config)) {
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

    this.graph = new StateGraph(ExpertState)
      .addNode("retrieve", retrieve)
      .addNode("respond", respond)
      .addEdge(START, "retrieve")
      .addEdge("retrieve", "respond")
      .addEdge("respond", END)
      .compile();
  }

  async *answer({
    messages,
    retrieval,
    signal,
  }: OrchestratorInput): AsyncGenerator<OrchestratorEvent> {
    try {
      const stream = await this.graph.stream(
        { messages: messages.map(toLangChainMessage), retrieval: retrieval ?? null },
        { streamMode: "custom", signal },
      );

      for await (const event of stream) {
        if (isOrchestratorEvent(event)) {
          yield event;
        }
      }
    } catch (error) {
      throw error instanceof ExpertKnowledgeUnavailableError ? error : toExpertModelError(error);
    }
  }
}
