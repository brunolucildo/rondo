import { Alert } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { Spinner } from "@repo/ui/spinner";
import { useEffect, useId, useRef, useState } from "react";

export interface ClearConversationProps {
  expertName: string;
  /** An answer is running: clearing waits until it ends. */
  disabled: boolean;
  isClearing: boolean;
  /** The last attempt to clear failed; the conversation is intact. */
  failed: boolean;
  onConfirm: () => void;
  /** The confirmation was closed without clearing (also forgets a failed attempt). */
  onCancel: () => void;
}

/**
 * "Clear conversation" with a confirmation. The confirmation is a labelled `alertdialog`: focus
 * goes to Cancel when it opens (the safe choice), Escape cancels and focus returns to the button
 * that opened it. A failed attempt keeps the dialog open with "Try again", the conversation intact.
 * When the clear succeeds the conversation disappears and with it this whole component.
 */
export function ClearConversation({
  expertName,
  disabled,
  isClearing,
  failed,
  onConfirm,
  onCancel,
}: ClearConversationProps) {
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const openerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    if (confirming) {
      dialogRef.current?.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
    } else if (wasConfirming.current) {
      openerRef.current?.querySelector("button")?.focus();
    }

    wasConfirming.current = confirming;
  }, [confirming]);

  function cancel() {
    setConfirming(false);
    onCancel();
  }

  if (!confirming) {
    return (
      <div ref={openerRef} className="flex justify-end">
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => setConfirming(true)}>
          Clear conversation
        </Button>
      </div>
    );
  }

  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isClearing) {
          cancel();
        }
      }}
      className="space-y-3 rounded-md border-2 border-border bg-card p-4 shadow-pixel-sm"
    >
      <h2 id={titleId} className="text-base font-bold">
        Clear this conversation?
      </h2>
      <p id={descriptionId} className="text-base">
        All your messages with the {expertName} will be deleted. This can&apos;t be undone.
      </p>
      {failed ? <Alert variant="error">We couldn&apos;t clear the conversation.</Alert> : null}
      <div className="flex flex-wrap gap-3">
        <Button data-cancel variant="outline" disabled={isClearing} onClick={cancel}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={isClearing} onClick={onConfirm}>
          {isClearing ? <Spinner className="size-5" /> : null}
          {failed ? "Try again" : "Delete conversation"}
        </Button>
      </div>
    </div>
  );
}
