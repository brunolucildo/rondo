import { Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool } from "pg";
import { createPostgresPoolConfig } from "../../config/database";
import type { Environment } from "../../config/environment";
import { createDatabaseClient, type DatabaseClient } from "../../observability/db-telemetry";
import { ClearConversation } from "./application/use-cases/clear-conversation.use-case";
import { GetConversation } from "./application/use-cases/get-conversation.use-case";
import { ListExperts } from "./application/use-cases/list-experts.use-case";
import { SendExpertMessage } from "./application/use-cases/send-expert-message.use-case";
import type { ConversationLock, ConversationRepository } from "./domain/conversation-ports";
import type { ExpertChatConfig } from "./domain/expert-chat-config";
import type { ExpertOrchestrator } from "./domain/expert-ports";
import {
  CONVERSATION_DATABASE,
  CONVERSATION_LOCK,
  CONVERSATION_REPOSITORY,
  EXPERT_CHAT_CONFIG,
  EXPERT_ORCHESTRATOR,
} from "./experts.tokens";
import { createExpertOrchestrator } from "./infrastructure/create-expert-orchestrator";
import { InMemoryConversationLock } from "./infrastructure/in-memory-conversation-lock";
import { PostgresConversationRepository } from "./infrastructure/postgres-conversation.repository";
import { ClearConversationRequestHandler } from "./interface/request-handlers/clear-conversation.request-handler";
import { GetConversationRequestHandler } from "./interface/request-handlers/get-conversation.request-handler";
import { ListExpertsRequestHandler } from "./interface/request-handlers/list-experts.request-handler";
import { SendExpertMessageRequestHandler } from "./interface/request-handlers/send-expert-message.request-handler";

@Module({
  controllers: [
    ListExpertsRequestHandler,
    SendExpertMessageRequestHandler,
    GetConversationRequestHandler,
    ClearConversationRequestHandler,
  ],
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
    {
      // The conversations do DML and call `expert_append_message` as `rondo_app` (ADR 0015).
      provide: CONVERSATION_DATABASE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) =>
        createDatabaseClient(
          new Pool(createPostgresPoolConfig(config.get("databaseUrl", { infer: true }))),
        ),
    },
    {
      provide: CONVERSATION_REPOSITORY,
      inject: [CONVERSATION_DATABASE],
      useFactory: (client: DatabaseClient) => new PostgresConversationRepository(client),
    },
    // In memory, so it only holds for one API instance (ADR 0005 and the conversation ADR).
    { provide: CONVERSATION_LOCK, useFactory: () => new InMemoryConversationLock() },
    { provide: ListExperts, useFactory: () => new ListExperts() },
    {
      provide: SendExpertMessage,
      inject: [EXPERT_ORCHESTRATOR, CONVERSATION_REPOSITORY, CONVERSATION_LOCK],
      useFactory: (
        orchestrator: ExpertOrchestrator,
        conversations: ConversationRepository,
        lock: ConversationLock,
      ) => new SendExpertMessage(orchestrator, conversations, lock),
    },
    {
      provide: GetConversation,
      inject: [CONVERSATION_REPOSITORY],
      useFactory: (conversations: ConversationRepository) => new GetConversation(conversations),
    },
    {
      provide: ClearConversation,
      inject: [CONVERSATION_REPOSITORY],
      useFactory: (conversations: ConversationRepository) => new ClearConversation(conversations),
    },
  ],
})
export class ExpertsModule implements OnModuleDestroy {
  constructor(@Inject(CONVERSATION_DATABASE) private readonly database: DatabaseClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.database.end();
  }
}
