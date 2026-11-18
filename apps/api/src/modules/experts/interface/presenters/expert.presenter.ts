import type { Expert } from "../../domain/expert";

export interface ExpertResponse {
  id: string;
  name: string;
  role: string;
  characterName: string;
  description: string;
  suggestedQuestions: string[];
  notice: string | null;
}

/** The public face of an expert. The persona (system prompt) is deliberately left out. */
export function presentExpert(expert: Expert): ExpertResponse {
  return {
    id: expert.id,
    name: expert.name,
    role: expert.role,
    characterName: expert.characterName,
    description: expert.description,
    suggestedQuestions: [...expert.suggestedQuestions],
    notice: expert.notice,
  };
}
