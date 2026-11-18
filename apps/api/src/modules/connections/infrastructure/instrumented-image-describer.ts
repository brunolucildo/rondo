import { recordVisionCall } from "../../../observability/connection-telemetry";
import { VisionRefusedError } from "../domain/connection-errors";
import type { ImageDescriber, ImageToDescribe } from "../domain/connection-ports";

/** Times every call to the vision model and records its outcome (closed set, no content). */
export class InstrumentedImageDescriber implements ImageDescriber {
  constructor(private readonly inner: ImageDescriber) {}

  async describe(image: ImageToDescribe, signal: AbortSignal): Promise<string> {
    const startedAt = performance.now();

    try {
      const answer = await this.inner.describe(image, signal);

      recordVisionCall("success", (performance.now() - startedAt) / 1000);

      return answer;
    } catch (error) {
      recordVisionCall(
        error instanceof VisionRefusedError ? "refused" : "unavailable",
        (performance.now() - startedAt) / 1000,
      );

      throw error;
    }
  }
}
