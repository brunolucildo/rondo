import { ChatOpenAI } from "@langchain/openai";
import type { ExpertChatConfig } from "../domain/expert-chat-config";
import type { ExpertOrchestrator, KnowledgeRetriever } from "../domain/expert-ports";
import { LangGraphExpertOrchestrator } from "./langgraph-expert-orchestrator";
import { ScriptedChatModel } from "./scripted-chat-model";
import { UnavailableExpertOrchestrator } from "./unavailable-expert-orchestrator";

/**
 * Builds the one orchestrator the environment selected; the others are never constructed. The
 * retriever feeds the graph with the chunks of the user's connected documents.
 */
export function createExpertOrchestrator(
  config: ExpertChatConfig,
  retriever: KnowledgeRetriever,
): ExpertOrchestrator {
  switch (config.provider) {
    case "openai":
      return new LangGraphExpertOrchestrator(
        new ChatOpenAI({
          model: config.model,
          apiKey: config.apiKey,
          temperature: 0.5,
          streaming: true,
          // The use case owns the retry policy (one attempt more, before the first token).
          maxRetries: 0,
        }),
        retriever,
      );
    case "fake":
      return new LangGraphExpertOrchestrator(new ScriptedChatModel({}), retriever);
    case "unavailable":
      return new UnavailableExpertOrchestrator();
  }
}
