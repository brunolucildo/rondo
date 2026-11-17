export class ExpertNotFoundError extends Error {
  constructor() {
    super("Expert not found.");
    this.name = "ExpertNotFoundError";
  }
}

/** No chat model is configured (for example `OPENAI_API_KEY` is missing). */
export class ExpertUnavailableError extends Error {
  constructor() {
    super("The experts are unavailable right now.");
    this.name = "ExpertUnavailableError";
  }
}

/**
 * The model could not answer. `retryable` says whether trying once more can help (rate limit,
 * server error, network, timeout); the message is fixed, never the provider's text.
 */
export class ExpertModelError extends Error {
  constructor(readonly retryable: boolean) {
    super("The model could not answer.");
    this.name = "ExpertModelError";
  }
}
