import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAccessToken } from "../../lib/access-token";
import { apiClient } from "../../lib/api-client";
import type { ConnectionDto } from "./connection-messages";

const REFRESH_WHILE_PROCESSING_MS = 3000;

interface ConnectionListResponse {
  connections: ConnectionDto[];
}

/**
 * The connections of the user, the most recent first (`GET /connections`). Only fetched while the
 * panel is open (`enabled`), and refreshed every few seconds while one of them is still being
 * processed. Always asks the server again when the panel opens: the list is never trusted stale.
 */
export function useConnectionList(enabled: boolean) {
  const token = getAccessToken();

  return useQuery({
    queryKey: ["connections", "list", token],
    queryFn: async ({ signal }) =>
      (await apiClient.get<ConnectionListResponse>("/connections", { signal })).connections,
    enabled: enabled && token !== null,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some((connection) => connection.status === "processing")
        ? REFRESH_WHILE_PROCESSING_MS
        : false,
  });
}

/** `DELETE /connections/:id`. Resolves when the server answered `204`. */
export function useDeleteConnection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (connectionId: string) => apiClient.delete(`/connections/${connectionId}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["connections", "list"] }),
  });
}

/** `DELETE /connections`: every connection of the user. */
export function useDeleteAllConnections() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => apiClient.delete("/connections"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["connections", "list"] }),
  });
}
