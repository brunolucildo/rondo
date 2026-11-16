import type { ReactNode } from "react";
import { RedCardIcon } from "./icons";
import { Label } from "./label";
import { cn } from "./lib/utils";

/** What the control must receive to be linked to its label and error text. */
export interface FieldControlProps {
  id: string;
  "aria-invalid": true | undefined;
  "aria-describedby": string | undefined;
}

export interface FieldProps {
  /** Id of the control; the error text gets `${id}-error`. */
  id: string;
  label: string;
  /** Error text. When set, the control is marked invalid and described by it. */
  error?: string;
  /** Extra content after the error text (for example a link that fixes it). */
  errorAction?: ReactNode;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/**
 * Label + control + error text, wired together: `htmlFor`/`id`, `aria-invalid` and
 * `aria-describedby`. The control is a render prop so any input can be used. The error shows the
 * red card icon and text, never color alone.
 */
export function Field({ id, label, error, errorAction, className, children }: FieldProps) {
  const errorId = `${id}-error`;
  const hasError = error !== undefined && error !== "";

  return (
    <div data-slot="field" className={cn("space-y-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        "aria-invalid": hasError ? true : undefined,
        "aria-describedby": hasError ? errorId : undefined,
      })}
      {hasError ? (
        <p className="flex items-start gap-2 text-base font-bold text-destructive">
          <RedCardIcon className="h-6 w-5 shrink-0 text-foreground" />
          <span id={errorId} className="min-w-0">
            {error}
            {errorAction}
          </span>
        </p>
      ) : null}
    </div>
  );
}
