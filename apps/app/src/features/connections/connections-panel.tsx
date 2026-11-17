import { Alert } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { type ChangeEvent, useId, useRef, useState } from "react";
import { ConfirmDeleteDialog } from "./confirm-delete-dialog";
import {
  ACCEPTED_EXTENSIONS,
  type ConnectionDto,
  describeDeleteFailure,
  describeProcessingFailure,
  formatSize,
  kindLabel,
  statusLabel,
} from "./connection-messages";
import { ModalDialog } from "./modal-dialog";
import { useAttachments } from "./use-attachments";
import {
  useConnectionList,
  useDeleteAllConnections,
  useDeleteConnection,
} from "./use-connection-list";

type Confirmation = { scope: "single"; connection: ConnectionDto } | { scope: "all" };

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

/** Placeholder of the list while it loads. Announced as a status. */
function ListLoading() {
  return (
    <div role="status">
      <span className="sr-only">Loading your connections…</span>
      <div aria-hidden="true" className="space-y-2">
        <div className="h-14 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-14 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      </div>
    </div>
  );
}

interface ConnectionRowProps {
  connection: ConnectionDto;
  disabled: boolean;
  onDelete: (connection: ConnectionDto) => void;
}

function ConnectionRow({ connection, disabled, onDelete }: ConnectionRowProps) {
  const failure =
    connection.status === "failed" ? describeProcessingFailure(connection.errorCode).text : null;

  return (
    <li className="flex flex-col gap-2 rounded-md border-2 border-border bg-background p-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold" title={connection.name}>
          {connection.name}
        </p>
        <p className="text-sm text-muted-foreground">
          {kindLabel(connection.kind)} · {formatSize(connection.sizeBytes)} ·{" "}
          {statusLabel(connection.status)} ·{" "}
          <time dateTime={connection.createdAt}>{formatDate(connection.createdAt)}</time>
        </p>
        {failure === null ? null : <p className="text-sm text-destructive">{failure}</p>}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="min-h-11 self-end sm:self-auto"
        disabled={disabled}
        aria-label={`Delete ${connection.name}`}
        onClick={() => onDelete(connection)}
      >
        Delete
      </Button>
    </li>
  );
}

export interface ConnectionsPanelProps {
  onClose: () => void;
}

/**
 * The panel of connections (spec 0025), opened from the floating button: the section "Add" to
 * connect another file and the section "Your connections" with what the experts know. Each item
 * has `Delete` and the list has `Delete all`, both behind a confirmation that names what goes and
 * says it cannot be undone. The list is read from the server every time the panel opens; a
 * deletion is only shown as done after the server answered `204`.
 */
export function ConnectionsPanel({ onClose }: ConnectionsPanelProps) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { addFile, connectionsDeleted } = useAttachments();
  const list = useConnectionList(true);
  const deleteOne = useDeleteConnection();
  const deleteAll = useDeleteAllConnections();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const connections = list.data ?? [];
  const isDeleting = deleteOne.isPending || deleteAll.isPending;

  function pickFile() {
    inputRef.current?.click();
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    // Cleared so choosing the same file again fires `change` again.
    event.target.value = "";

    if (file !== undefined) {
      addFile(file);
      onClose();
    }
  }

  function closeConfirmation() {
    setConfirmation(null);
    setFailure(null);
  }

  function finished(deletedIds: readonly string[], message: string) {
    connectionsDeleted(deletedIds);
    closeConfirmation();
    setNotice(message);
    // The row that had the focus is gone: the heading takes it, after the dialog gave it back.
    setTimeout(() => headingRef.current?.focus(), 0);
  }

  function confirmDeletion() {
    if (confirmation === null) {
      return;
    }

    const scope = confirmation.scope;
    const deletedIds =
      confirmation.scope === "single"
        ? [confirmation.connection.id]
        : connections.map((connection) => connection.id);
    const handlers = {
      onSuccess: () =>
        finished(
          deletedIds,
          scope === "single" ? "Connection deleted." : "All connections deleted.",
        ),
      onError: (error: unknown) => {
        const described = describeDeleteFailure(error, scope);

        if (described.reload) {
          // Someone else already removed it: nothing to confirm, the list is fetched again.
          finished(deletedIds, "That connection was already removed.");
        } else {
          setFailure(described.text);
        }
      },
    };

    setFailure(null);

    if (confirmation.scope === "single") {
      deleteOne.mutate(confirmation.connection.id, handlers);
    } else {
      deleteAll.mutate(undefined, handlers);
    }
  }

  return (
    <>
      <ModalDialog
        titleId={titleId}
        onClose={onClose}
        inert={confirmation !== null}
        className="max-h-[85dvh] max-w-xl space-y-5 overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className="font-display text-xl">
            Connections
          </h2>
          <Button variant="outline" size="sm" className="min-h-11" onClick={onClose}>
            Close
          </Button>
        </div>

        <section aria-labelledby={`${ids}-add`} className="space-y-2">
          <h3 id={`${ids}-add`} className="text-base font-bold">
            Add
          </h3>
          <p className="text-sm text-muted-foreground">
            PDF, TXT or Markdown, up to 20 MB. Your experts will answer from what you connect.
          </p>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS.join(",")}
            onChange={handleFileChange}
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="panel-file-input"
          />
          <Button variant="secondary" onClick={pickFile}>
            Choose a file
          </Button>
        </section>

        <section aria-labelledby={`${ids}-list`} className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 id={`${ids}-list`} className="text-base font-bold">
              Your connections
            </h3>
            {connections.length > 0 ? (
              <Button
                variant="destructive"
                size="sm"
                className="min-h-11"
                disabled={isDeleting}
                onClick={() => setConfirmation({ scope: "all" })}
              >
                Delete all
              </Button>
            ) : null}
          </div>

          {list.isError ? (
            <div className="space-y-3">
              <Alert variant="error">We couldn&apos;t load your connections.</Alert>
              <Button variant="outline" onClick={() => void list.refetch()}>
                Try again
              </Button>
            </div>
          ) : list.data === undefined ? (
            <ListLoading />
          ) : connections.length === 0 ? (
            <div className="space-y-3">
              <p className="text-base">No connections yet</p>
              <Button variant="secondary" onClick={pickFile}>
                Add a file
              </Button>
            </div>
          ) : (
            <ul aria-label="Your connections" className="space-y-2">
              {connections.map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  connection={connection}
                  disabled={isDeleting}
                  onDelete={(target) => setConfirmation({ scope: "single", connection: target })}
                />
              ))}
            </ul>
          )}
        </section>
        <p role="status" className="sr-only">
          {notice}
        </p>
      </ModalDialog>

      {confirmation === null ? null : (
        <ConfirmDeleteDialog
          title={
            confirmation.scope === "single"
              ? "Delete this connection?"
              : `Delete all ${connections.length} ${connections.length === 1 ? "connection" : "connections"}?`
          }
          subject={
            confirmation.scope === "single"
              ? `"${confirmation.connection.name}"`
              : connections.length === 1
                ? "Your connection"
                : `All ${connections.length} of your connections`
          }
          confirmLabel={confirmation.scope === "single" ? "Delete connection" : "Delete all"}
          isDeleting={isDeleting}
          failure={failure}
          onConfirm={confirmDeletion}
          onCancel={closeConfirmation}
        />
      )}
    </>
  );
}
