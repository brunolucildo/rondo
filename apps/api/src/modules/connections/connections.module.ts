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
import type {
  ConnectionRepository,
  ConnectionTelemetry,
  ImageDescriber,
} from "./domain/connection-ports";
import { parseVisionConfig } from "./domain/vision-config";
import {
  CONNECTION_REPOSITORY,
  CONNECTION_TELEMETRY,
  CONNECTIONS_DATABASE,
  IMAGE_DESCRIBER,
} from "./connections.tokens";
import { createImageDescriber } from "./infrastructure/create-image-describer";
import { ImageDocumentExtractor } from "./infrastructure/image-document-extractor";
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
 * Connections of the user (spec 0023): upload of PDF, TXT and Markdown files (spec 0026 adds JPG
 * and PNG images, turned into text by a vision model), deduplication by
 * content, background processing into the knowledge index, and the status endpoint. Spec 0025
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
      // The only place that picks the vision model: OpenAI, the scripted fake (NODE_ENV=test) or none.
      provide: IMAGE_DESCRIBER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ImageDescriber =>
        createImageDescriber(
          parseVisionConfig(
            {
              OPENAI_API_KEY: config.get<string>("OPENAI_API_KEY"),
              OPENAI_VISION_MODEL: config.get<string>("OPENAI_VISION_MODEL"),
            },
            resolveNodeEnv({ NODE_ENV: config.get<string>("NODE_ENV") }),
          ),
        ),
    },
    {
      provide: ConnectionProcessor,
      inject: [
        CONNECTION_REPOSITORY,
        EMBEDDINGS_GENERATOR,
        KNOWLEDGE_INDEX,
        CONNECTION_TELEMETRY,
        IMAGE_DESCRIBER,
      ],
      useFactory: (
        repository: ConnectionRepository,
        embeddings: EmbeddingsGenerator,
        index: KnowledgeIndex,
        telemetry: ConnectionTelemetry,
        describer: ImageDescriber,
      ) =>
        new ConnectionProcessor({
          repository,
          extractors: {
            pdf: new LangChainDocumentExtractor("pdf"),
            txt: new LangChainDocumentExtractor("txt"),
            md: new LangChainDocumentExtractor("md"),
            image: new ImageDocumentExtractor(describer),
          },
          chunker: new RecursiveTextChunker(),
          embeddings,
          index,
          telemetry,
        }),
    },
    {
      provide: UploadConnection,
      inject: [CONNECTION_REPOSITORY, ConnectionProcessor, CONNECTION_TELEMETRY],
      useFactory: (
        repository: ConnectionRepository,
        processor: ConnectionProcessor,
        telemetry: ConnectionTelemetry,
      ) => new UploadConnection(repository, new NodeContentHasher(), processor, telemetry),
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
  ) {}

  /** Lets the processing in flight finish (it writes its final status), then closes the pool. */
  async onApplicationShutdown(): Promise<void> {
    await this.processor.idle();
    await this.database.end();
  }
}
