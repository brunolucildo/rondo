import type {
  ResolvedCitation,
  ResolvedMessage,
  ResolvedMessagePage,
} from "../../domain/conversation-ports";

export interface ConversationMessageResponse {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "incomplete";
  /** `null`: no retrieval ran; `[]`: no connected source covers the question. */
  citations: ResolvedCitation[] | null;
  createdAt: string;
}

export interface ConversationResponse {
  messages: ConversationMessageResponse[];
  nextCursor: string | null;
}

export function presentMessage(message: ResolvedMessage): ConversationMessageResponse {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    status: message.status,
    citations: message.citations,
    createdAt: message.createdAt.toISOString(),
  };
}

export function presentConversation(page: ResolvedMessagePage): ConversationResponse {
  return { messages: page.messages.map(presentMessage), nextCursor: page.nextCursor };
}
