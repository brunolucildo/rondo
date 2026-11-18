import { Alert } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { Spinner } from "@repo/ui/spinner";
import { useId } from "react";
import { ModalDialog } from "./modal-dialog";

export interface ConfirmDeleteDialogProps {
  title: string;
  /** What will be deleted, named for the person. */
  subject: string;
  /** The label of the button that confirms (the failure turns it into "Try again"). */
  confirmLabel: string;
  isDeleting: boolean;
  /** The last attempt failed with this message; the connection is still there. */
  failure: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirmation of an irreversible deletion. A labelled `alertdialog`: the focus goes to
 * `Cancel` (the safe choice), Escape cancels and the focus goes back to what opened it. It names
 * what will be deleted, says it cannot be undone and that the answers already given stay in the
 * conversations. A failed attempt keeps it open with the reason and `Try again`.
 */
export function ConfirmDeleteDialog({
  title,
  subject,
  confirmLabel,
  isDeleting,
  failure,
  onConfirm,
  onCancel,
}: ConfirmDeleteDialogProps) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const descriptionId = `${ids}-description`;

  return (
    <ModalDialog
      role="alertdialog"
      raised
      titleId={titleId}
      descriptionId={descriptionId}
      initialFocus="[data-cancel]"
      onClose={() => {
        if (!isDeleting) {
          onCancel();
        }
      }}
      className="space-y-4"
    >
      <h2 id={titleId} className="font-display text-xl">
        {title}
      </h2>
      <div id={descriptionId} className="space-y-2 text-base">
        <p>{subject} will be removed from what your experts know. This can&apos;t be undone.</p>
        <p>
          Answers that already used it stay in your conversations, and their sources will show
          &quot;Source removed&quot;. To remove the answers too, clear the conversation.
        </p>
      </div>
      {failure === null ? null : <Alert variant="error">{failure}</Alert>}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button data-cancel variant="outline" disabled={isDeleting} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={isDeleting} onClick={onConfirm}>
          {isDeleting ? <Spinner className="size-5" /> : null}
          {failure === null ? confirmLabel : "Try again"}
        </Button>
      </div>
    </ModalDialog>
  );
}
