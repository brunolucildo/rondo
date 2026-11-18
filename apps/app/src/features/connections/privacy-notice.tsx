import { Button } from "@repo/ui/button";
import { type KeyboardEvent, useEffect, useId, useRef } from "react";

export interface PrivacyNoticeProps {
  onAccept: () => void;
  onCancel: () => void;
}

/**
 * The notice shown before the first file is sent (once per browser). A modal dialog: focus moves
 * to `Cancel` (the safe choice), Tab stays inside, Escape cancels and focus returns to where it
 * was. Nothing is uploaded until the person accepts.
 */
export function PrivacyNotice({ onAccept, onCancel }: PrivacyNoticeProps) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const descriptionId = `${ids}-description`;
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement;

    // The first button is `Cancel`, the safe choice. Deferred a tick: the file picker may hand
    // the focus back to the page right after the choice that opened this notice.
    const timer = setTimeout(() => dialogRef.current?.querySelector("button")?.focus(), 0);

    return () => {
      clearTimeout(timer);

      if (opener instanceof HTMLElement) {
        opener.focus();
      }
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();

      return;
    }

    if (event.key === "Tab") {
      const buttons = dialogRef.current?.querySelectorAll("button") ?? [];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/60 p-4 sm:items-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleKeyDown}
        className="w-full max-w-md space-y-4 rounded-md border-2 border-border bg-card p-5 shadow-pixel"
      >
        <h2 id={titleId} className="font-display text-xl">
          Before you connect a file
        </h2>
        <p id={descriptionId} className="text-base">
          The content of the file is sent to an AI provider to be turned into searchable data
          (embeddings). Images are sent to the AI provider too, to be described and read as text.
          Personal and health data must only be used with the authorization of the people concerned.
          The original file is not kept: only the extracted text is stored.
        </p>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onAccept}>I understand, continue</Button>
        </div>
      </div>
    </div>
  );
}
