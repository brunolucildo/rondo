import { useQuery } from "@tanstack/react-query";
import { getAccessToken } from "../../lib/access-token";
import { apiClient } from "../../lib/api-client";

/** An expert as `GET /experts` describes it. The avatar is not part of it: the app picks it by `id`. */
export interface Expert {
  id: string;
  name: string;
  role: string;
  characterName: string;
  description: string;
  suggestedQuestions: string[];
  /** Fixed notice shown under the prompt field, or `null`. */
  notice: string | null;
}

interface ExpertsResponse {
  experts: Expert[];
}

/** The fixed catalog of experts. The token is part of the key, like the session. */
export function useExperts() {
  const token = getAccessToken();

  return useQuery({
    queryKey: ["experts", token],
    queryFn: async () => (await apiClient.get<ExpertsResponse>("/experts")).experts,
    enabled: token !== null,
    // The catalog is fixed in code on the server: no need to ask again while the page is open.
    staleTime: Infinity,
    // Shown with "Try again", not retried behind the user's back.
    retry: false,
  });
}
