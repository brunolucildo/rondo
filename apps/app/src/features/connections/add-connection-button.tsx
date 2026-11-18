import { Button } from "@repo/ui/button";
import { type ChangeEvent, useRef } from "react";
import { ACCEPTED_EXTENSIONS } from "./connection-messages";
import { useAttachments } from "./use-attachments";

/**
 * The floating "Add connection" button: it opens the file picker (PDF, TXT, Markdown, JPG, PNG, MP3 and MP4). It is a
 * real button (keyboard and screen reader friendly), 44 px high; the parent positions it above the
 * composer. The chosen file becomes a chip; the privacy notice comes first on the first use.
 */
export function AddConnectionButton({ className }: { className?: string }) {
  const { addFile } = useAttachments();
  const inputRef = useRef<HTMLInputElement>(null);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    // Cleared so choosing the same file again fires `change` again.
    event.target.value = "";

    if (file !== undefined) {
      addFile(file);
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS.join(",")}
        onChange={handleChange}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="connection-file-input"
      />
      <Button variant="secondary" className={className} onClick={() => inputRef.current?.click()}>
        Add connection
      </Button>
    </>
  );
}
