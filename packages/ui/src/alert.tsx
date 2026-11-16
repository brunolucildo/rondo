import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { GoalIcon, RedCardIcon, WhistleIcon, YellowCardIcon } from "./icons";
import { cn } from "./lib/utils";

const alertVariants = cva("flex items-start gap-3 rounded-md border-2 p-3 text-base", {
  variants: {
    variant: {
      error: "border-destructive bg-background text-foreground",
      warning: "border-border bg-warning text-warning-foreground",
      success: "border-border bg-success text-success-foreground",
      info: "border-border bg-info text-info-foreground",
    },
  },
  defaultVariants: { variant: "info" },
});

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>["variant"]>;

const ICONS = {
  error: RedCardIcon,
  warning: YellowCardIcon,
  success: GoalIcon,
  info: WhistleIcon,
} as const;

/** Errors and warnings interrupt (`alert`); successes and info are polite (`status`). */
const ROLES = { error: "alert", warning: "alert", success: "status", info: "status" } as const;

export interface AlertProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "role">, VariantProps<typeof alertVariants> {}

/**
 * Notice with the football vocabulary: red card (error), yellow card (warning), ball in the net
 * (success) and whistle (info). The icon never carries the meaning alone: the message is text.
 */
export function Alert({ variant, className, children, ...props }: AlertProps) {
  const kind: AlertVariant = variant ?? "info";
  const Icon = ICONS[kind];

  return (
    <div
      data-slot="alert"
      data-variant={kind}
      role={ROLES[kind]}
      className={cn(alertVariants({ variant: kind }), className)}
      {...props}
    >
      <Icon className="h-6 w-6 shrink-0" />
      <div className="min-w-0 flex-1 font-bold">{children}</div>
    </div>
  );
}

export { alertVariants };
