export const EXPERT_IDS = [
  "head-coach",
  "performance-analyst",
  "sports-lawyer",
  "physiologist",
  "sports-physician",
  "physiotherapist",
  "football-manager",
] as const;

export type ExpertId = (typeof EXPERT_IDS)[number];

/** The persona that becomes the system prompt. It never leaves the server. */
export interface ExpertPersona {
  /** How the expert speaks. */
  tone: string;
  /** What the expert helps with. */
  scope: string;
  /** What the expert must never do. Each entry becomes one rule of the prompt. */
  limits: readonly string[];
  /** Extra notes about voice and mannerisms (only the Head Coach has them). */
  style?: string;
  /** Health and legal experts send questions that need an individual assessment to a professional. */
  refersToProfessional: boolean;
}

export interface Expert {
  id: ExpertId;
  name: string;
  role: string;
  /** A fictional character: never a real person. */
  characterName: string;
  description: string;
  persona: ExpertPersona;
  /** Written in pt-BR, the language of the answers. Between 3 and 6 per expert. */
  suggestedQuestions: readonly string[];
  /** Fixed notice shown under the prompt field, or `null` when the expert has none. */
  notice: string | null;
}
