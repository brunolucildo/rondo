import { cn } from "@repo/ui/lib/utils";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";

const FOCUSABLE =
  "button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])";

export interface ModalDialogProps {
  role?: "dialog" | "alertdialog";
  titleId: string;
  descriptionId?: string;
  /** Escape asks to close. The caller decides whether it is allowed right now. */
  onClose: () => void;
  /** Selector of the element that gets the focus on open; the first button when absent. */
  initialFocus?: string;
  /** Stacks above another dialog (the confirmation over the panel). */
  raised?: boolean;
  /** Makes the dialog (and its overlay) unreachable, while another one is on top of it. */
  inert?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * A modal dialog: it takes the focus when it opens (the safe choice first), keeps Tab inside,
 * closes with Escape and gives the focus back to what opened it. The page behind is covered by a
 * dimmed overlay. Used for the panel of connections and for the confirmation of a deletion.
 */
export function ModalDialog({
  role = "dialog",
  titleId,
  descriptionId,
  onClose,
  initialFocus,
  raised = false,
  inert = false,
  className,
  children,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement;

    // Deferred a tick: the control that opened the dialog may hand the focus back right after.
    const timer = setTimeout(() => {
      const target =
        initialFocus === undefined ? null : dialogRef.current?.querySelector(initialFocus);

      (target instanceof HTMLElement
        ? target
        : dialogRef.current?.querySelector("button")
      )?.focus();
    }, 0);

    return () => {
      clearTimeout(timer);

      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
    // Only on mount: the initial focus must not move while the dialog is open.
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();

      return;
    }

    if (event.key === "Tab") {
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

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
    <div
      inert={inert}
      className={cn(
        "fixed inset-0 flex items-end justify-center bg-foreground/60 p-4 sm:items-center",
        raised ? "z-[60]" : "z-50",
      )}
    >
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-full max-w-md rounded-md border-2 border-border bg-card p-5 shadow-pixel",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
