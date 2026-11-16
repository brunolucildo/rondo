import type { InputHTMLAttributes } from "react";
import { cn } from "./lib/utils";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/**
 * Text field. Pair it with a `Label` (`htmlFor`/`id`) and, for errors, set
 * `aria-invalid` and point `aria-describedby` at the error text: the invalid
 * state changes the border (thicker, destructive color) in addition to the text.
 */
export function Input({ className, type = "text", ...props }: InputProps) {
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(
        "h-11 w-full rounded-md border-2 border-input bg-background px-3 py-2 text-base text-foreground shadow-[inset_2px_2px_0_0_var(--muted)] placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[3px] aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}
