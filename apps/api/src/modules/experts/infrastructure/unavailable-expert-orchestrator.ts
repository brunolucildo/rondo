import { ExpertUnavailableError } from "../domain/expert-errors";
import type { ExpertOrchestrator, OrchestratorEvent } from "../domain/expert-ports";

/** Stands in when no chat model is configured: the use case refuses before it is ever called. */
export class UnavailableExpertOrchestrator implements ExpertOrchestrator {
  readonly available = false;

  answer(): AsyncIterable<OrchestratorEvent> {
    throw new ExpertUnavailableError();
  }
}
