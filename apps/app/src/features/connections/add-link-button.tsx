import { Button } from "@repo/ui/button";
import { Field } from "@repo/ui/field";
import { Input } from "@repo/ui/input";
import { type ChangeEvent, type FormEvent, useId, useState } from "react";
import { checkLinkBeforeSend } from "./connection-messages";
import { ModalDialog } from "./modal-dialog";
import { useAttachments } from "./use-attachments";

interface LinkDialogProps {
  onClose: () => void;
}

/**
 * The dialog of the field "Link" (spec 0027). The button stays disabled while the field is empty;
 * a link that is plainly wrong is explained next to the field, keeping what was typed. A valid one
 * becomes a chip (the server checks it again and may refuse it there) and the dialog closes.
 */
function LinkDialog({ onClose }: LinkDialogProps) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const descriptionId = `${ids}-description`;
  const { addLink } = useAttachments();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setValue(event.target.value);
    setError(undefined);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const problem = checkLinkBeforeSend(value);

    if (problem !== null) {
      setError(problem);

      return;
    }

    addLink(value);
    onClose();
  }

  return (
    <ModalDialog
      titleId={titleId}
      descriptionId={descriptionId}
      onClose={onClose}
      initialFocus="input"
    >
      <form noValidate onSubmit={handleSubmit} className="space-y-4">
        <h2 id={titleId} className="font-display text-xl">
          Add a link
        </h2>
        <p id={descriptionId} className="text-base">
          Paste the address of a public page, text file, Markdown file or PDF. Pages that need a
          login are not supported.
        </p>
        <Field id={`${ids}-link`} label="Link" {...(error === undefined ? {} : { error })}>
          {(control) => (
            <Input
              {...control}
              name="link"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.com/page"
              value={value}
              onChange={handleChange}
            />
          )}
        </Field>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={value.trim() === ""}>
            Connect link
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

/**
 * The floating "Add link" button, next to "Add connection": it opens the dialog with the field
 * "Link". A real button (keyboard and screen reader friendly), 44 px high.
 */
export function AddLinkButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="secondary" className={className} onClick={() => setOpen(true)}>
        Add link
      </Button>
      {open ? <LinkDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
