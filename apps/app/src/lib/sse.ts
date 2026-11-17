export interface SseMessage {
  /** The `event:` name; `message` when the block has none. */
  event: string;
  /** The `data:` payload parsed as JSON. */
  data: unknown;
}

function parseBlock(block: string): SseMessage | null {
  let event = "message";
  const data: string[] = [];

  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }

  if (data.length === 0) {
    return null;
  }

  try {
    return { event, data: JSON.parse(data.join("\n")) as unknown };
  } catch {
    // A malformed block is dropped: the stream keeps going.
    return null;
  }
}

/**
 * Reads a Server-Sent Events body and yields one message per event. Chunks can split an event
 * anywhere (even inside a multi-byte character), so the text is decoded as a stream and cut
 * only at blank lines. Releases the reader when the consumer stops early.
 */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n?/g, "\n");

      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        const message = parseBlock(buffer.slice(0, boundary));

        buffer = buffer.slice(boundary + 2);

        if (message !== null) {
          yield message;
        }

        boundary = buffer.indexOf("\n\n");
      }

      if (done) {
        const rest = parseBlock(buffer);

        if (rest !== null) {
          yield rest;
        }

        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
