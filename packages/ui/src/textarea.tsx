import type { ComponentProps } from "react";
import { cn } from "./lib/utils";

/** `ComponentProps` (not the HTML attributes alone) so `ref` is accepted, as React 19 allows. */
export type TextareaProps = ComponentProps<"textarea">;

/**
 * Multi-line text field, styled like `Input`. It does not resize by hand (`resize-none`); a
 * caller that wants it to grow sets the height itself. Pair it with a `Label` (or `aria-label`)
 * and, for errors, `aria-invalid` and `aria-describedby`.
 */
export function Textarea({ className, rows = 1, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      rows={rows}
      className={cn(
        "min-h-11 w-full resize-none rounded-md border-2 border-input bg-background px-3 py-2 text-base leading-6 text-foreground shadow-[inset_2px_2px_0_0_var(--muted)] placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[3px] aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}
