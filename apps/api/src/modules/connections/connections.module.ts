import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool } from "pg";
import { createPostgresPoolConfig } from "../../config/database";
import type { Environment } from "../../config/environment";
import { createDatabaseClient, type DatabaseClient } from "../../observability/db-telemetry";
import {
  EMBEDDINGS_GENERATOR,
  type EmbeddingsGenerator,
  KNOWLEDGE_INDEX,
  type KnowledgeIndex,
  KnowledgeModule,
} from "../knowledge";
import { ConnectionProcessor } from "./application/services/connection-processor";
import { GetConnection } from "./application/use-cases/get-connection.use-case";
import { UploadConnection } from "./application/use-cases/upload-connection.use-case";
import type { ConnectionRepository, ConnectionTelemetry } from "./domain/connection-ports";
import {
  CONNECTION_REPOSITORY,
  CONNECTION_TELEMETRY,
  CONNECTIONS_DATABASE,
} from "./connections.tokens";
import { LangChainDocumentExtractor } from "./infrastructure/langchain-document-extractor";
import { NodeContentHasher } from "./infrastructure/node-content-hasher";
import { OtelConnectionTelemetry } from "./infrastructure/otel-connection-telemetry";
import { PostgresConnectionRepository } from "./infrastructure/postgres-connection.repository";
import { RecursiveTextChunker } from "./infrastructure/recursive-text-chunker";
import { GetConnectionRequestHandler } from "./interface/request-handlers/get-connection.request-handler";
import { UploadConnectionRequestHandler } from "./interface/request-handlers/upload-connection.request-handler";

/**
 * Connections of the user (spec 0023): upload of PDF, TXT and Markdown files, deduplication by
 * content, background processing into the knowledge index, and the status endpoint. It uses the
 * `knowledge` ports (`KnowledgeIndex`, `EmbeddingsGenerator`) and its own Postgres pool.
 */
@Module({
  imports: [KnowledgeModule],
  controllers: [UploadConnectionRequestHandler, GetConnectionRequestHandler],
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
      provide: ConnectionProcessor,
      inject: [CONNECTION_REPOSITORY, EMBEDDINGS_GENERATOR, KNOWLEDGE_INDEX, CONNECTION_TELEMETRY],
      useFactory: (
        repository: ConnectionRepository,
        embeddings: EmbeddingsGenerator,
        index: KnowledgeIndex,
        telemetry: ConnectionTelemetry,
      ) =>
        new ConnectionProcessor({
          repository,
          extractors: {
            pdf: new LangChainDocumentExtractor("pdf"),
            txt: new LangChainDocumentExtractor("txt"),
            md: new LangChainDocumentExtractor("md"),
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
  ],
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
