import { ExpertModelError } from "../../src/modules/experts/domain/expert-errors";
import type {
  ExpertOrchestrator,
  OrchestratorEvent,
  OrchestratorInput,
  TokenUsage,
} from "../../src/modules/experts/domain/expert-ports";

/** What a fake does for one call: `attempt` is 1 for the first call, 2 for the retry. */
export type OrchestratorScript = (
  input: OrchestratorInput,
  attempt: number,
) => AsyncIterable<OrchestratorEvent>;

function stream(
  next: () => Promise<IteratorResult<OrchestratorEvent>>,
): AsyncIterable<OrchestratorEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      next,
      return: () => Promise.resolve({ done: true, value: undefined }),
    }),
  };
}

/** Streams the given pieces and ends (optionally reporting token usage first). */
export function speaks(pieces: readonly string[], usage?: TokenUsage): OrchestratorScript {
  return () =>
    (async function* () {
      for (const text of pieces) {
        yield { type: "text", text } satisfies OrchestratorEvent;
      }

      if (usage !== undefined) {
        yield { type: "usage", usage } satisfies OrchestratorEvent;
      }
    })();
}

/** Fails on the first read, before any token. */
export function fails(retryable = true): OrchestratorScript {
  return () => stream(() => Promise.reject(new ExpertModelError(retryable)));
}

/** Streams the pieces and then fails: the failure comes after the first token. */
export function speaksThenFails(pieces: readonly string[]): OrchestratorScript {
  return () => {
    let index = 0;

    return stream(() =>
      index < pieces.length
        ? Promise.resolve({ done: false, value: { type: "text", text: pieces[index++] ?? "" } })
        : Promise.reject(new ExpertModelError(true)),
    );
  };
}

/** Produces nothing and only ends (with an error) when the signal aborts, like a real model call. */
export function waitsForAbort(): OrchestratorScript {
  return ({ signal }) =>
    stream(
      () =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
}

/** Produces nothing and ignores the signal: a stuck call the use case must not wait for. */
export function hangs(): OrchestratorScript {
  return () => stream(() => new Promise(() => undefined));
}

/** Runs a different script on each attempt. */
export function perAttempt(...scripts: OrchestratorScript[]): OrchestratorScript {
  return (input, attempt) => {
    const script = scripts[attempt - 1] ?? scripts[scripts.length - 1];

    if (script === undefined) {
      throw new Error("perAttempt needs at least one script");
    }

    return script(input, attempt);
  };
}

/**
 * An orchestrator the test controls. It records every call (messages and signal), so a test can
 * check what the model would have received and whether the call was aborted.
 */
export class FakeExpertOrchestrator implements ExpertOrchestrator {
  available = true;
  readonly calls: OrchestratorInput[] = [];

  constructor(private script: OrchestratorScript = speaks(["Fake ", "answer."])) {}

  use(script: OrchestratorScript): this {
    this.script = script;

    return this;
  }

  answer(input: OrchestratorInput): AsyncIterable<OrchestratorEvent> {
    this.calls.push(input);

    return this.script(input, this.calls.length);
  }
}
