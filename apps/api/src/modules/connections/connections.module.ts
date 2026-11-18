import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool } from "pg";
import { createPostgresPoolConfig } from "../../config/database";
import type { Environment } from "../../config/environment";
import { createDatabaseClient, type DatabaseClient } from "../../observability/db-telemetry";
import { resolveNodeEnv } from "../email";
import {
  EMBEDDINGS_GENERATOR,
  type EmbeddingsGenerator,
  KNOWLEDGE_INDEX,
  type KnowledgeIndex,
  KnowledgeModule,
} from "../knowledge";
import { ConnectionProcessor } from "./application/services/connection-processor";
import { DeleteAllConnections } from "./application/use-cases/delete-all-connections.use-case";
import { DeleteConnection } from "./application/use-cases/delete-connection.use-case";
import { GetConnection } from "./application/use-cases/get-connection.use-case";
import { ListConnections } from "./application/use-cases/list-connections.use-case";
import { UploadConnection } from "./application/use-cases/upload-connection.use-case";
import type { ConnectionRepository, ConnectionTelemetry } from "./domain/connection-ports";
import type { MediaUnderstanding } from "./domain/media-understanding";
import {
  CONNECTION_REPOSITORY,
  CONNECTION_TELEMETRY,
  CONNECTIONS_DATABASE,
  MEDIA_UNDERSTANDING,
} from "./connections.tokens";
import { FakeMediaUnderstanding } from "./infrastructure/fake-media-understanding";
import { createGeminiClient } from "./infrastructure/gemini-client";
import {
  DEFAULT_UNDERSTANDING_MODEL,
  GeminiMediaUnderstanding,
} from "./infrastructure/gemini-media-understanding";
import { MediaDocumentExtractor } from "./infrastructure/media-document-extractor";
import { TimedTextChunker } from "./infrastructure/timed-text-chunker";
import { LangChainDocumentExtractor } from "./infrastructure/langchain-document-extractor";
import { NodeContentHasher } from "./infrastructure/node-content-hasher";
import { OtelConnectionTelemetry } from "./infrastructure/otel-connection-telemetry";
import { PostgresConnectionRepository } from "./infrastructure/postgres-connection.repository";
import { RecursiveTextChunker } from "./infrastructure/recursive-text-chunker";
import { DeleteAllConnectionsRequestHandler } from "./interface/request-handlers/delete-all-connections.request-handler";
import { DeleteConnectionRequestHandler } from "./interface/request-handlers/delete-connection.request-handler";
import { GetConnectionRequestHandler } from "./interface/request-handlers/get-connection.request-handler";
import { ListConnectionsRequestHandler } from "./interface/request-handlers/list-connections.request-handler";
import { UploadConnectionRequestHandler } from "./interface/request-handlers/upload-connection.request-handler";

/**
 * Connections of the user (spec 0023): upload of PDF, TXT and Markdown files, deduplication by
 * content, background processing into the knowledge index, and the status endpoint. Spec 0028 adds
 * audio and video (MP3 and MP4) through the media understanding port (Gemini). Spec 0025
 * adds the listing and the deletion (one or all: vectors first, then the record). It uses the
 * `knowledge` ports (`KnowledgeIndex`, `EmbeddingsGenerator`) and its own Postgres pool.
 */
@Module({
  imports: [KnowledgeModule],
  controllers: [
    UploadConnectionRequestHandler,
    ListConnectionsRequestHandler,
    GetConnectionRequestHandler,
    DeleteConnectionRequestHandler,
    DeleteAllConnectionsRequestHandler,
  ],
  providers: [
    {
      // Server only: DML as `rondo_app`. Closed on shutdown, after the processing in flight ends.
      provide: CONNECTIONS_DATABASE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) =>
        createDatabaseClient(
          new Pool(createPostgresPoolConfig(config.get("databaseUrl", { infer: true }))),
        ),
    },
    {
      provide: CONNECTION_REPOSITORY,
      inject: [CONNECTIONS_DATABASE],
      useFactory: (database: DatabaseClient) => new PostgresConnectionRepository(database),
    },
    { provide: CONNECTION_TELEMETRY, useClass: OtelConnectionTelemetry },
    {
      // Audio and video (spec 0028): the offline fake when `NODE_ENV=test`, Gemini when
      // `GEMINI_API_KEY` is set, otherwise unavailable (the upload answers 503 MEDIA_UNAVAILABLE).
      provide: MEDIA_UNDERSTANDING,
      inject: [ConfigService],
      useFactory: (env: ConfigService): MediaUnderstanding => {
        if (resolveNodeEnv({ NODE_ENV: env.get<string>("NODE_ENV") }) === "test") {
          return new FakeMediaUnderstanding();
        }

        const apiKey = env.get<string>("GEMINI_API_KEY")?.trim();
        const model = env.get<string>("GEMINI_UNDERSTANDING_MODEL")?.trim();

        return new GeminiMediaUnderstanding(
          apiKey ? createGeminiClient(apiKey, model || DEFAULT_UNDERSTANDING_MODEL) : undefined,
        );
      },
    },
    {
      provide: ConnectionProcessor,
      inject: [
        CONNECTION_REPOSITORY,
        EMBEDDINGS_GENERATOR,
        KNOWLEDGE_INDEX,
        CONNECTION_TELEMETRY,
        MEDIA_UNDERSTANDING,
      ],
      useFactory: (
        repository: ConnectionRepository,
        embeddings: EmbeddingsGenerator,
        index: KnowledgeIndex,
        telemetry: ConnectionTelemetry,
        media: MediaUnderstanding,
      ) =>
        new ConnectionProcessor({
          repository,
          extractors: {
            pdf: new LangChainDocumentExtractor("pdf"),
            txt: new LangChainDocumentExtractor("txt"),
            md: new LangChainDocumentExtractor("md"),
            audio: new MediaDocumentExtractor("audio", media),
            video: new MediaDocumentExtractor("video", media),
          },
          chunker: new RecursiveTextChunker(),
          mediaChunker: new TimedTextChunker(),
          embeddings,
          index,
          telemetry,
        }),
    },
    {
      provide: UploadConnection,
      inject: [
        CONNECTION_REPOSITORY,
        ConnectionProcessor,
        CONNECTION_TELEMETRY,
        MEDIA_UNDERSTANDING,
      ],
      useFactory: (
        repository: ConnectionRepository,
        processor: ConnectionProcessor,
        telemetry: ConnectionTelemetry,
        media: MediaUnderstanding,
      ) =>
        new UploadConnection(
          repository,
          new NodeContentHasher(),
          processor,
          telemetry,
          () => new Date(),
          () => media.isAvailable(),
        ),
    },
    {
      provide: GetConnection,
      inject: [CONNECTION_REPOSITORY],
      useFactory: (repository: ConnectionRepository) => new GetConnection(repository),
    },
    {
      provide: ListConnections,
      inject: [CONNECTION_REPOSITORY],
      useFactory: (repository: ConnectionRepository) => new ListConnections(repository),
    },
    {
      provide: DeleteConnection,
      inject: [CONNECTION_REPOSITORY, KNOWLEDGE_INDEX, CONNECTION_TELEMETRY],
      useFactory: (
        repository: ConnectionRepository,
        index: KnowledgeIndex,
        telemetry: ConnectionTelemetry,
      ) => new DeleteConnection(repository, index, telemetry),
    },
    {
      provide: DeleteAllConnections,
      inject: [CONNECTION_REPOSITORY, KNOWLEDGE_INDEX, CONNECTION_TELEMETRY],
      useFactory: (
        repository: ConnectionRepository,
        index: KnowledgeIndex,
        telemetry: ConnectionTelemetry,
      ) => new DeleteAllConnections(repository, index, telemetry),
    },
  ],
  // The experts read the status of the user's connections (spec 0024) through this port.
  exports: [CONNECTION_REPOSITORY],
})
export class ConnectionsModule implements OnApplicationShutdown {
  constructor(
    @Inject(ConnectionProcessor) private readonly processor: ConnectionProcessor,
    @Inject(CONNECTIONS_DATABASE) private readonly database: DatabaseClient,
    @Inject(MEDIA_UNDERSTANDING) private readonly media: MediaUnderstanding,
  ) {}

  /** Lets the processing in flight finish (it writes its final status), then closes the pool. */
  async onApplicationShutdown(): Promise<void> {
    await this.processor.idle();

    if (this.media instanceof GeminiMediaUnderstanding) {
      this.media.dispose();
    }

    await this.database.end();
  }
}
