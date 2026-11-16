import type { ComponentProps, HTMLAttributes } from "react";
import { cn } from "./lib/utils";

/** Ticket-style container: hard border, offset pixel shadow, a perforated line under the header. */
export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      data-slot="card"
      className={cn(
        "rounded-md border-2 border-border bg-card text-card-foreground shadow-pixel",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="card-header"
      className={cn("space-y-3 border-b-2 border-dashed border-border px-6 py-5", className)}
      {...props}
    />
  );
}

export interface CardTitleProps extends ComponentProps<"h1"> {
  /** Heading level: `h1` for the main title of a screen, `h2` inside one. */
  as?: "h1" | "h2" | "h3";
}

/** Short title in the display font. Long titles wrap and stay balanced. */
export function CardTitle({ as: Heading = "h2", className, ...props }: CardTitleProps) {
  return (
    <Heading
      data-slot="card-title"
      className={cn(
        "font-display text-base leading-relaxed text-balance break-words text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      data-slot="card-description"
      className={cn("text-base text-muted-foreground", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="card-content" className={cn("px-6 py-6", className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="card-footer"
      className={cn("border-t-2 border-dashed border-border px-6 py-3", className)}
      {...props}
    />
  );
}
