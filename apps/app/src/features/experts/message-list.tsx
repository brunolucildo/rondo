import { Alert } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { YellowCardIcon } from "@repo/ui/icons";
import { Spinner } from "@repo/ui/spinner";
import { ExpertAvatar } from "./expert-avatar";
import type { ChatMessage, ExpertMessage } from "./chat-state";
import type { Expert } from "./use-experts";

/** The text of a failed answer; `null` for an answer that did not fail. */
function failureText(status: ExpertMessage["status"]): string | null {
  switch (status) {
    case "error":
      return "The expert couldn't answer.";
    case "unavailable":
      return "The experts are unavailable right now.";
    case "rate-limited":
      return "You're sending messages too fast. Wait a moment and try again.";
    default:
      return null;
  }
}

function ExpertBubble({
  expert,
  message,
  canRetry,
  onRetry,
}: {
  expert: Expert;
  message: ExpertMessage;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const retry = canRetry ? (
    <Button variant="outline" size="sm" onClick={onRetry}>
      Try again
    </Button>
  ) : null;
  const failure = failureText(message.status);

  return (
    <div className="flex items-start gap-3">
      <ExpertAvatar expertId={expert.id} className="size-12" />
      <div className="max-w-[85%] min-w-0 space-y-2">
        <p className="text-sm font-bold">
          <span className="sr-only">Answer from </span>
          {expert.name}
        </p>
        {message.content !== "" ? (
          <p className="rounded-md border-2 border-border bg-card px-4 py-3 text-base break-words whitespace-pre-wrap text-card-foreground shadow-pixel-sm">
            {message.content}
          </p>
        ) : null}
        {message.status === "streaming" && message.content === "" ? (
          <p className="flex items-center gap-3 rounded-md border-2 border-border bg-card px-4 py-3 text-base text-muted-foreground shadow-pixel-sm">
            <Spinner className="size-6" />
            The expert is answering…
          </p>
        ) : null}
        {message.status === "incomplete" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex items-center gap-2 text-sm font-bold">
              <YellowCardIcon className="h-5 w-4 shrink-0" />
              Incomplete answer
            </p>
            {retry}
          </div>
        ) : null}
        {failure !== null ? (
          <div className="space-y-2">
            <Alert variant="error">{failure}</Alert>
            {retry}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface MessageListProps {
  expert: Expert;
  messages: readonly ChatMessage[];
  isAnswering: boolean;
  onRetry: () => void;
}

/**
 * The conversation. A `log` live region that stays in the page even when it is empty (a region
 * added together with its content is not announced). While an answer streams it is `aria-busy`,
 * so a screen reader waits and reads the answer when it ends, not word by word.
 */
export function MessageList({ expert, messages, isAnswering, onRetry }: MessageListProps) {
  const lastId = messages.at(-1)?.id;

  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="Conversation"
      aria-busy={isAnswering}
      className="space-y-5"
    >
      {messages.map((message) =>
        message.role === "user" ? (
          <div key={message.id} className="flex justify-end">
            <div className="max-w-[85%] rounded-md border-2 border-border bg-primary px-4 py-3 text-base text-primary-foreground shadow-pixel-sm">
              <span className="sr-only">You said</span>
              <p className="break-words whitespace-pre-wrap">{message.content}</p>
            </div>
          </div>
        ) : (
          <ExpertBubble
            key={message.id}
            expert={expert}
            message={message}
            canRetry={message.id === lastId && !isAnswering}
            onRetry={onRetry}
          />
        ),
      )}
    </div>
  );
}
