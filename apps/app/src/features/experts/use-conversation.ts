import { useQuery } from "@tanstack/react-query";
import { getAccessToken } from "../../lib/access-token";
import { apiClient } from "../../lib/api-client";
import type { StoredMessage } from "./chat-state";

interface ConversationResponse {
  messages: StoredMessage[];
  nextCursor: string | null;
}

/**
 * The stored conversation of the user with one expert (the newest page, oldest message first).
 * It is only the starting point of the chat on screen, so it is never kept in the cache (`gcTime`
 * 0) and never refetched behind the chat's back: every visit to an expert asks the server again,
 * and leaving the expert cancels a request that is still running. A failure shows "Try again".
 */
export function useConversation(expertId: string) {
  const token = getAccessToken();

  return useQuery({
    queryKey: ["experts", token, expertId, "conversation"],
    queryFn: async ({ signal }) =>
      (await apiClient.get<ConversationResponse>(`/experts/${expertId}/conversation`, { signal }))
        .messages,
    enabled: token !== null,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
