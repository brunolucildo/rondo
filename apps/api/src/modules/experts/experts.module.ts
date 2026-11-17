import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Environment } from "../../config/environment";
import { ListExperts } from "./application/use-cases/list-experts.use-case";
import { SendExpertMessage } from "./application/use-cases/send-expert-message.use-case";
import type { ExpertChatConfig } from "./domain/expert-chat-config";
import type { ExpertOrchestrator } from "./domain/expert-ports";
import { EXPERT_CHAT_CONFIG, EXPERT_ORCHESTRATOR } from "./experts.tokens";
import { createExpertOrchestrator } from "./infrastructure/create-expert-orchestrator";
import { ListExpertsRequestHandler } from "./interface/request-handlers/list-experts.request-handler";
import { SendExpertMessageRequestHandler } from "./interface/request-handlers/send-expert-message.request-handler";

@Module({
  controllers: [ListExpertsRequestHandler, SendExpertMessageRequestHandler],
  providers: [
    {
      provide: EXPERT_CHAT_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>): ExpertChatConfig =>
        config.get("expertChat", { infer: true }),
    },
    {
      // The only place that picks the model: OpenAI, the scripted fake (NODE_ENV=test) or none.
      provide: EXPERT_ORCHESTRATOR,
      inject: [EXPERT_CHAT_CONFIG],
      useFactory: createExpertOrchestrator,
    },
    { provide: ListExperts, useFactory: () => new ListExperts() },
    {
      provide: SendExpertMessage,
      inject: [EXPERT_ORCHESTRATOR],
      useFactory: (orchestrator: ExpertOrchestrator) => new SendExpertMessage(orchestrator),
    },
  ],
})
export class ExpertsModule {}
