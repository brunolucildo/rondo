import {
  type EmbeddingsGenerator,
  EmbeddingsUnavailableError,
  type KnowledgeIndex,
  KnowledgeIndexUnavailableError,
  KnowledgeInputError,
} from "../../knowledge";
import {
  failureReasonOf,
  type KnowledgeFailureReason,
} from "../../../observability/knowledge-telemetry";
import { traceExpertRetrieval } from "../../../observability/expert-telemetry";
import type { ExpertRetrievalConfig } from "../domain/expert-retrieval-config";
import { ExpertKnowledgeUnavailableError } from "../domain/expert-errors";
import type { KnowledgeRetriever, RetrievalRequest } from "../domain/expert-ports";
import type { RetrievedChunk } from "../domain/grounding";

function reasonOf(error: unknown): KnowledgeFailureReason {
  if (
    error instanceof EmbeddingsUnavailableError ||
    error instanceof KnowledgeIndexUnavailableError
  ) {
    return failureReasonOf(error.code);
  }

  return error instanceof KnowledgeInputError ? "invalid_input" : "unknown";
}

/**
 * `KnowledgeRetriever` over the `knowledge` ports: embeds the question, searches the tenant of the
 * user (restricted to the attached connections when there are any) and keeps the chunks at or
 * above the similarity threshold, best first, up to the configured number. Any failure of the
 * embeddings or of the index is `ExpertKnowledgeUnavailableError`: the answer never goes on without
 * a source for somebody who has connections. Nothing here logs the question or the text.
 */
export class KnowledgeIndexRetriever implements KnowledgeRetriever {
  constructor(
    private readonly embeddings: EmbeddingsGenerator,
    private readonly index: KnowledgeIndex,
    private readonly config: ExpertRetrievalConfig,
  ) {}

  async retrieve(request: RetrievalRequest, signal: AbortSignal): Promise<RetrievedChunk[]> {
    const scope = request.connectionIds === null ? "all" : "connections";

    try {
      return await traceExpertRetrieval(
        scope,
        async () => {
          const vector = await this.embeddings.embedQuery(request.question);

          // Stop pressed while the question was being embedded: skip the search.
          signal.throwIfAborted();

          const hits = await this.index.search(request.userId, vector, {
            limit: this.config.maxChunks,
            ...(request.connectionIds === null ? {} : { connectionIds: request.connectionIds }),
          });
          const chunks = hits
            .filter((hit) => hit.score >= this.config.minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, this.config.maxChunks);

          return {
            value: chunks,
            outcome: chunks.length === 0 ? ("gap" as const) : ("found" as const),
            chunks: chunks.length,
          };
        },
        reasonOf,
      );
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }

      throw new ExpertKnowledgeUnavailableError();
    }
  }
}
