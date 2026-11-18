import { ConnectionProcessingError } from "../domain/connection-errors";
import type { ImageDescriber } from "../domain/connection-ports";

/** No OpenAI key: the image fails at once with `PROCESSING_UNAVAILABLE`, with no retry and no network. */
export class UnavailableImageDescriber implements ImageDescriber {
  describe(): Promise<string> {
    return Promise.reject(new ConnectionProcessingError("PROCESSING_UNAVAILABLE"));
  }
}
