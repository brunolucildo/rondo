import { Button } from "@repo/ui/button";
import { Label } from "@repo/ui/label";
import { Select } from "@repo/ui/select";
import { Spinner } from "@repo/ui/spinner";
import { Textarea } from "@repo/ui/textarea";
import { type FormEvent, type KeyboardEvent, useId, useLayoutEffect, useRef } from "react";
import { MESSAGE_LIMIT } from "./chat-state";
import { ExpertAvatar } from "./expert-avatar";
import type { Expert } from "./use-experts";

const MAX_TEXTAREA_HEIGHT_PX = 160;

export interface ComposerProps {
  experts: readonly Expert[];
  expert: Expert;
  onSelectExpert: (expertId: string) => void;
  draft: string;
  onDraftChange: (draft: string) => void;
  isAnswering: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
}

/**
 * The bar fixed at the bottom: the expert dropdown, the prompt field and Send (or Stop while an
 * answer runs). Enter sends, Shift+Enter breaks the line. The fixed notice of the legal and
 * health experts sits under the field and is tied to it with `aria-describedby`.
 */
export function Composer({
  experts,
  expert,
  onSelectExpert,
  draft,
  onDraftChange,
  isAnswering,
  onSend,
  onStop,
}: ComposerProps) {
  const ids = useId();
  const selectId = `${ids}-expert`;
  const textareaId = `${ids}-message`;
  const noticeId = `${ids}-notice`;
  const limitId = `${ids}-limit`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const message = draft.trim();
  const tooLong = message.length > MESSAGE_LIMIT;
  const canSend = message !== "" && !tooLong && !isAnswering;
  const describedBy =
    [tooLong ? limitId : null, expert.notice === null ? null : noticeId]
      .filter(Boolean)
      .join(" ") || undefined;

  // Grows with the text up to a ceiling, then scrolls: the text is never cut at 375 px.
  useLayoutEffect(() => {
    const field = textareaRef.current;

    if (field === null || field.scrollHeight === 0) {
      return;
    }

    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [draft]);

  function submit() {
    if (canSend) {
      onSend(message);
      onDraftChange("");
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // `isComposing`: Enter that confirms an input-method candidate must not send.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="sticky bottom-0 z-10 border-t-2 border-border bg-card pb-[env(safe-area-inset-bottom)]">
      <form
        aria-label="Send a message"
        onSubmit={handleSubmit}
        className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-3"
      >
        <div className="space-y-1">
          <Label htmlFor={selectId} className="text-sm">
            Expert
          </Label>
          <div className="flex items-center gap-3">
            <ExpertAvatar expertId={expert.id} className="size-12" />
            <div className="min-w-0 flex-1">
              <Select
                id={selectId}
                value={expert.id}
                onChange={(event) => onSelectExpert(event.target.value)}
              >
                {experts.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name} - {option.role}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </div>
        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor={textareaId} className="sr-only">
              Message for the {expert.name}
            </Label>
            <Textarea
              id={textareaId}
              ref={textareaRef}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Ask the ${expert.name}…`}
              aria-invalid={tooLong ? true : undefined}
              aria-describedby={describedBy}
              className="max-h-40 overflow-y-auto"
            />
          </div>
          {isAnswering ? (
            <Button variant="outline" size="lg" onClick={onStop} className="min-w-24">
              <Spinner className="size-5" />
              Stop
            </Button>
          ) : (
            <Button type="submit" size="lg" disabled={!canSend} className="min-w-24">
              Send
            </Button>
          )}
        </div>
        {tooLong ? (
          <p id={limitId} className="text-sm font-bold text-destructive">
            Messages can have at most {MESSAGE_LIMIT.toLocaleString("en-US")} characters.
          </p>
        ) : null}
        {expert.notice === null ? null : (
          <p id={noticeId} className="text-sm text-muted-foreground">
            {expert.notice}
          </p>
        )}
      </form>
    </div>
  );
}
