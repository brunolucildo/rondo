/** Limits of the contract with `POST /experts/:expertId/messages`. */
export const MESSAGE_LIMIT = 4000;
export const HISTORY_LIMIT = 20;

export type ExpertMessageStatus =
  | "streaming"
  | "done"
  | "incomplete"
  | "error"
  | "unavailable"
  | "rate-limited";

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

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * What the API receives as `history`: the last 20 turns that make sense as context. Answers
 * that failed or have no text are left out; each text is cut to the 4,000 characters the API
 * accepts (an answer can be longer than that).
 */
export function buildHistory(messages: readonly ChatMessage[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ role: "user", content: message.content.slice(0, MESSAGE_LIMIT) });
    } else if (
      (message.status === "done" || message.status === "incomplete") &&
      message.content !== ""
    ) {
      turns.push({ role: "assistant", content: message.content.slice(0, MESSAGE_LIMIT) });
    }
  }

  return turns.slice(-HISTORY_LIMIT);
}

export type ChatAction =
  | { type: "sent"; userId: string; expertId: string; content: string }
  | { type: "delta"; id: string; text: string }
  | { type: "finished"; id: string }
  | { type: "stopped"; id: string }
  | { type: "failed"; id: string; status: "error" | "unavailable" | "rate-limited" }
  /** Drops the failed answer and puts a new empty one in its place, for "Try again". */
  | { type: "retried"; id: string; newId: string };

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
  }
}
