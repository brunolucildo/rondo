/** The longest message the API accepts from the user. */
export const MESSAGE_LIMIT = 4000;

export type ExpertMessageStatus =
  | "streaming"
  | "done"
  | "incomplete"
  | "error"
  | "unavailable"
  | "rate-limited"
  | "busy";

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
}

export type ChatMessage = UserMessage | ExpertMessage;

/** A message as `GET /experts/:expertId/conversation` returns it. */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "incomplete";
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
        },
  );
}

export type ChatAction =
  | { type: "sent"; userId: string; expertId: string; content: string }
  | { type: "delta"; id: string; text: string }
  | { type: "finished"; id: string }
  | { type: "stopped"; id: string }
  | { type: "failed"; id: string; status: "error" | "unavailable" | "rate-limited" | "busy" }
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
        { id: action.expertId, role: "expert", content: "", status: "streaming" },
      ];
    case "delta":
      return patchExpert(messages, action.id, (message) => ({
        ...message,
        content: message.content + action.text,
      }));
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
          ? { id: action.newId, role: "expert", content: "", status: "streaming" }
          : message,
      );
    case "cleared":
      return [];
  }
}
