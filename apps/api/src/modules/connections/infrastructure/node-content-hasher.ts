import { createHash } from "node:crypto";
import type { ContentHasher } from "../domain/connection-ports";

export class NodeContentHasher implements ContentHasher {
  sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }
}
