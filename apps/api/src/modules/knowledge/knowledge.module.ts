import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { resolveNodeEnv } from "../email";
import type { EmbeddingsGenerator } from "./domain/embeddings-generator";
import { type KnowledgeConfig, parseKnowledgeConfig } from "./domain/knowledge-config";
import { FakeEmbeddingsGenerator } from "./infrastructure/fake-embeddings-generator";
import {
  InstrumentedEmbeddingsGenerator,
  InstrumentedKnowledgeIndex,
} from "./infrastructure/instrumented";
import {
  createOpenAiEmbeddingsClient,
  OpenAiEmbeddingsGenerator,
} from "./infrastructure/openai-embeddings-generator";
import {
  createWeaviateConnector,
  WeaviateKnowledgeIndex,
} from "./infrastructure/weaviate-knowledge-index";
import { EMBEDDINGS_GENERATOR, KNOWLEDGE_CONFIG, KNOWLEDGE_INDEX } from "./knowledge.tokens";

const ENV_NAMES = [
  "WEAVIATE_URL",
  "WEAVIATE_GRPC_PORT",
  "WEAVIATE_API_KEY",
  "WEAVIATE_COLLECTION",
  "OPENAI_API_KEY",
] as const;

/**
 * Knowledge infrastructure: the per-user vector index (Weaviate, one tenant per user) and the
 * embeddings generator (OpenAI; the offline fake when `NODE_ENV=test`). Consumers inject the ports
 * by `KNOWLEDGE_INDEX` and `EMBEDDINGS_GENERATOR`. Importing the module requires `WEAVIATE_URL` and
 * `WEAVIATE_API_KEY`; the Weaviate connection itself is opened on first use, so the API boots
 * even while Weaviate is still starting.
 */
@Module({
  providers: [
    {
      provide: KNOWLEDGE_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): KnowledgeConfig =>
        parseKnowledgeConfig(
          Object.fromEntries(ENV_NAMES.map((name) => [name, config.get<string>(name)])),
        ),
    },
    {
      provide: KNOWLEDGE_INDEX,
      inject: [KNOWLEDGE_CONFIG],
      useFactory: (config: KnowledgeConfig) => {
        const weaviate = new WeaviateKnowledgeIndex(createWeaviateConnector(config), {
          collection: config.collection,
        });

        return new InstrumentedKnowledgeIndex(weaviate, () => weaviate.close());
      },
    },
    {
      provide: EMBEDDINGS_GENERATOR,
      inject: [KNOWLEDGE_CONFIG, ConfigService],
      useFactory: (config: KnowledgeConfig, env: ConfigService): EmbeddingsGenerator => {
        if (resolveNodeEnv({ NODE_ENV: env.get<string>("NODE_ENV") }) === "test") {
          return new FakeEmbeddingsGenerator();
        }

        return new InstrumentedEmbeddingsGenerator(
          new OpenAiEmbeddingsGenerator(
            config.openAiApiKey === undefined
              ? undefined
              : createOpenAiEmbeddingsClient(config.openAiApiKey),
          ),
        );
      },
    },
  ],
  exports: [KNOWLEDGE_INDEX, EMBEDDINGS_GENERATOR],
})
export class KnowledgeModule implements OnApplicationShutdown {
  constructor(@Inject(KNOWLEDGE_INDEX) private readonly index: InstrumentedKnowledgeIndex) {}

  /** Closes the Weaviate connection (gRPC channel) so the process can exit cleanly. */
  async onApplicationShutdown(): Promise<void> {
    await this.index.close();
  }
}
