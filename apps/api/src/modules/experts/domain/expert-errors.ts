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

/** Another answer of the same user with the same expert is still being generated. */
export class ConversationBusyError extends Error {
  constructor() {
    super("This expert is still answering.");
    this.name = "ConversationBusyError";
  }
}

/** The `before` cursor is not one this server produced. */
export class InvalidCursorError extends Error {
  constructor() {
    super("The cursor is invalid.");
    this.name = "InvalidCursorError";
  }
}

/** A failed read or write of the conversation. The message never carries data. */
export class ConversationStorageError extends Error {
  constructor(readonly operation: string) {
    super(`Conversation storage failed: ${operation}.`);
    this.name = "ConversationStorageError";
  }
}

/** The embeddings or the vector index could not serve the retrieval of the question. */
export class ExpertKnowledgeUnavailableError extends Error {
  constructor() {
    super("The knowledge base is unavailable right now.");
    this.name = "ExpertKnowledgeUnavailableError";
  }
}

/** A `connectionIds` entry is not a connection of the user (or does not exist). */
export class ConnectionNotFoundError extends Error {
  constructor() {
    super("Connection not found.");
    this.name = "ConnectionNotFoundError";
  }
}

/** A `connectionIds` entry is a connection of the user that is not `ready` yet (or failed). */
export class ConnectionNotReadyError extends Error {
  constructor() {
    super("The connection is not ready.");
    this.name = "ConnectionNotReadyError";
  }
}
