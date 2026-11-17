import { Button } from "@repo/ui/button";
import { Spinner } from "@repo/ui/spinner";
import { cn } from "@repo/ui/lib/utils";
import { type AttachmentView, useAttachments } from "./use-attachments";

const PHASE_TEXT = {
  uploading: "Uploading…",
  processing: "Processing…",
  ready: "Ready",
} as const;

function Chip({ attachment }: { attachment: AttachmentView }) {
  const { removeAttachment, retryAttachment } = useAttachments();
  const { phase } = attachment;
  const failed = phase === "failed";

  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border-2 bg-background px-3 py-1 text-sm",
        failed ? "border-destructive" : "border-border",
      )}
    >
      <span className="max-w-full min-w-0 truncate font-bold" title={attachment.name}>
        {attachment.name}
      </span>
      {phase === "failed" ? (
        <span role="alert" className="min-w-0 flex-1 basis-full text-destructive sm:basis-auto">
          {attachment.message}
        </span>
      ) : (
        <span role="status" className="flex items-center gap-1 text-muted-foreground">
          {phase === "ready" ? null : <Spinner className="size-4" />}
          {PHASE_TEXT[phase]}
        </span>
      )}
      <span className="ml-auto flex gap-1">
        {failed && attachment.canRetry ? (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11"
            aria-label={`Try again with ${attachment.name}`}
            onClick={() => retryAttachment(attachment.id)}
          >
            Try again
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11"
          aria-label={`Remove ${attachment.name}`}
          onClick={() => removeAttachment(attachment.id)}
        >
          Remove
        </Button>
      </span>
    </li>
  );
}

/** The files attached to the next message, one chip each, with their state. Nothing when empty. */
export function AttachmentChips() {
  const { attachments } = useAttachments();

  if (attachments.length === 0) {
    return null;
  }

  return (
    <ul aria-label="Attachments" className="flex flex-col gap-2">
      {attachments.map((attachment) => (
        <Chip key={attachment.id} attachment={attachment} />
      ))}
    </ul>
  );
}
