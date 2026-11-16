import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md border-2 border-border text-base font-bold whitespace-nowrap transition-transform duration-150 ease-pixel touch-manipulation select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none active:translate-x-[2px] active:translate-y-[2px] [&:not(:disabled)]:active:shadow-none disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-pixel-sm hover:bg-accent",
        secondary: "bg-secondary text-secondary-foreground shadow-pixel-sm hover:bg-accent",
        outline: "bg-background text-foreground shadow-pixel-sm hover:bg-muted",
        ghost: "border-transparent bg-transparent text-foreground hover:bg-muted",
        destructive: "bg-destructive text-destructive-foreground shadow-pixel-sm hover:opacity-90",
      },
      size: {
        default: "h-11 px-4 py-2",
        sm: "h-9 px-3",
        lg: "h-12 px-6",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = "button",
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";

  return (
    <Component
      data-slot="button"
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { buttonVariants };
