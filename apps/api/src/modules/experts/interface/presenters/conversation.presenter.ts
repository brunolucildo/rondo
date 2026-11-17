import type { MessagePage, StoredMessage } from "../../domain/conversation-ports";

export interface ConversationMessageResponse {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "incomplete";
  createdAt: string;
}

export interface ConversationResponse {
  messages: ConversationMessageResponse[];
  nextCursor: string | null;
}

export function presentMessage(message: StoredMessage): ConversationMessageResponse {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    status: message.status,
    createdAt: message.createdAt.toISOString(),
  };
}

export function presentConversation(page: MessagePage): ConversationResponse {
  return { messages: page.messages.map(presentMessage), nextCursor: page.nextCursor };
}
