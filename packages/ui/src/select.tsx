import type { SelectHTMLAttributes } from "react";
import { ChevronDownIcon } from "./icons";
import { cn } from "./lib/utils";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/**
 * Dropdown built on the native `<select>`: the browser gives it the keyboard (arrows, Enter,
 * type-ahead) and the screen reader semantics for free. Styled like `Input`, with a pixel
 * chevron. Pair it with a `Label` (`htmlFor`/`id`); put the options as children.
 */
export function Select({ className, children, ...props }: SelectProps) {
  return (
    <div data-slot="select" className="relative w-full">
      <select
        className={cn(
          "h-11 w-full appearance-none truncate rounded-md border-2 border-input bg-background py-2 pr-10 pl-3 text-base text-foreground shadow-[inset_2px_2px_0_0_var(--muted)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[3px] aria-invalid:border-destructive",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 h-3 w-5 -translate-y-1/2 text-foreground" />
    </div>
  );
}
