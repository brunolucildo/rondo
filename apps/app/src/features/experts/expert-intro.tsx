import { Button } from "@repo/ui/button";
import { ExpertAvatar } from "./expert-avatar";
import type { Expert } from "./use-experts";

export interface ExpertIntroProps {
  expert: Expert;
  /** Sends the question as it is written. */
  onAsk: (question: string) => void;
  disabled?: boolean;
}

/** The empty state of an expert: who it is and questions that start the conversation. */
export function ExpertIntro({ expert, onAsk, disabled = false }: ExpertIntroProps) {
  return (
    <section
      aria-labelledby="expert-intro-name"
      className="flex flex-col items-center gap-6 py-6 text-center"
    >
      <ExpertAvatar expertId={expert.id} className="size-24" />
      <div className="space-y-2">
        <h2
          id="expert-intro-name"
          className="font-display text-base leading-relaxed text-balance break-words"
        >
          {expert.name}
        </h2>
        <p className="font-mono text-base font-bold text-muted-foreground">{expert.role}</p>
        <p className="mx-auto max-w-prose text-base text-balance">{expert.description}</p>
        <p className="text-sm text-muted-foreground">{expert.characterName} · AI character</p>
      </div>
      <div className="w-full max-w-xl space-y-3 text-left">
        <h3 className="text-base font-bold">Try asking</h3>
        <ul className="space-y-3">
          {expert.suggestedQuestions.map((question) => (
            <li key={question}>
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => onAsk(question)}
                className="h-auto min-h-11 w-full justify-start py-3 text-left font-normal whitespace-normal"
              >
                {question}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
