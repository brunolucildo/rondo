import { BallIcon, type PixelIconProps } from "./icons";
import { cn } from "./lib/utils";

/**
 * Loading indicator: a pixel ball turning in steps. It is decorative (`aria-hidden`): pair it
 * with text and announce the state in a live region (`role="status"`) or `aria-busy`. Static
 * with a reduced-motion preference.
 */
export function Spinner({ className, ...props }: PixelIconProps) {
  return (
    <BallIcon
      data-slot="spinner"
      className={cn("size-7 shrink-0 animate-pixel-spin motion-reduce:animate-none", className)}
      {...props}
    />
  );
}
