/** The longest message the API accepts from the user. */
export const MESSAGE_LIMIT = 4000;

export type ExpertMessageStatus =
  | "streaming"
  | "done"
  | "incomplete"
  | "error"
  | "unavailable"
  | "rate-limited"
  | "busy"
  | "knowledge-unavailable";

/**
 * A source an answer used, as the server built it. It has no text of the chunk on purpose: the
 * server never stores it either.
 */
export interface Citation {
  connectionId: string;
  sourceName: string;
  /** One-based, or `null` for a source without pages. */
  page: number | null;
  position: number;
  /** Second of an audio or video the passage starts at (spec 0028); absent for the other kinds. */
  startSeconds?: number;
  /** Only the conversation read from the server says it (`false` while the source exists). */
  removed?: false;
}

/**
 * A source that was deleted after the answer (spec 0025): the server sends no name for it, and the
 * interface shows "Source removed".
 */
export interface RemovedCitation {
  connectionId: string;
  removed: true;
}

/** What an answer lists as a source: a live one, or one whose connection no longer exists. */
export type AnswerCitation = Citation | RemovedCitation;

export interface UserMessage {
  id: string;
  role: "user";
  content: string;
}

export interface ExpertMessage {
  id: string;
  role: "expert";
  content: string;
  status: ExpertMessageStatus;
  /**
   * The sources of the answer. `null`: no search ran (the user had no connected file). `[]`: it ran
   * and no connected source covers the question.
   */
  citations: AnswerCitation[] | null;
}

export type ChatMessage = UserMessage | ExpertMessage;

/** A message as `GET /experts/:expertId/conversation` returns it. */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "incomplete";
  /** Absent in answers stored before the sources existed. */
  citations?: AnswerCitation[] | null;
  createdAt: string;
}

/** The conversation read from the server, as the list the chat shows (the expert is `assistant`). */
export function fromStoredMessages(stored: readonly StoredMessage[]): ChatMessage[] {
  return stored.map((message): ChatMessage =>
    message.role === "user"
      ? { id: message.id, role: "user", content: message.content }
      : {
          id: message.id,
          role: "expert",
          content: message.content,
          status: message.status === "incomplete" ? "incomplete" : "done",
          citations: message.citations ?? null,
        },
  );
}

export type ChatAction =
  | { type: "sent"; userId: string; expertId: string; content: string }
  | { type: "delta"; id: string; text: string }
  | { type: "finished"; id: string }
  | { type: "stopped"; id: string }
  | { type: "citations"; id: string; citations: Citation[] }
  | {
      type: "failed";
      id: string;
      status: "error" | "unavailable" | "rate-limited" | "busy" | "knowledge-unavailable";
    }
  /** The server refused the attached files before answering: the question and its answer go. */
  | { type: "unsent"; id: string }
  /** Drops the failed answer and puts a new empty one in its place, for "Try again". */
  | { type: "retried"; id: string; newId: string }
  /** The conversation was deleted on the server. */
  | { type: "cleared" };

function patchExpert(
  messages: readonly ChatMessage[],
  id: string,
  patch: (message: ExpertMessage) => ExpertMessage,
): ChatMessage[] {
  return messages.map((message) =>
    message.role === "expert" && message.id === id ? patch(message) : message,
  );
}

export function chatReducer(messages: ChatMessage[], action: ChatAction): ChatMessage[] {
  switch (action.type) {
    case "sent":
      return [
        ...messages,
        { id: action.userId, role: "user", content: action.content },
        { id: action.expertId, role: "expert", content: "", status: "streaming", citations: null },
      ];
    case "delta":
      return patchExpert(messages, action.id, (message) => ({
        ...message,
        content: message.content + action.text,
      }));
    case "citations":
      return patchExpert(messages, action.id, (message) => ({
        ...message,
        citations: action.citations,
      }));
    case "unsent": {
      const at = messages.findIndex(
        (message) => message.role === "expert" && message.id === action.id,
      );

      return at < 1 ? [...messages] : [...messages.slice(0, at - 1), ...messages.slice(at + 1)];
    }
    case "finished":
      return patchExpert(messages, action.id, (message) => ({ ...message, status: "done" }));
    case "stopped":
      return patchExpert(messages, action.id, (message) => ({ ...message, status: "incomplete" }));
    case "failed":
      // Text that already arrived stays, marked as incomplete; no text means a plain error.
      return patchExpert(messages, action.id, (message) => ({
        ...message,
        status: message.content !== "" && action.status === "error" ? "incomplete" : action.status,
      }));
    case "retried":
      return messages.map((message) =>
        message.role === "expert" && message.id === action.id
          ? { id: action.newId, role: "expert", content: "", status: "streaming", citations: null }
          : message,
      );
    case "cleared":
      return [];
  }
}
