import { PixelAvatar } from "@repo/ui/pixel-avatar";
import { cn } from "@repo/ui/lib/utils";

/**
 * Picture files by expert `id`. Empty until spec 0021 adds the generated avatars (one import per
 * expert, resolved by Vite); an `id` without an entry falls back to the pixel-art placeholder.
 */
export const AVATAR_IMAGES: Readonly<Record<string, string>> = {};

/** The same `id` always gets the same placeholder color. */
function variantOf(id: string): number {
  return [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

export interface ExpertAvatarProps {
  expertId: string;
  /** Picture files by id; the default is the app's own map. */
  images?: Readonly<Record<string, string>>;
  className?: string;
}

/** Decorative: the expert's name is always written next to it. */
export function ExpertAvatar({ expertId, images = AVATAR_IMAGES, className }: ExpertAvatarProps) {
  const source = Object.hasOwn(images, expertId) ? images[expertId] : undefined;

  if (source !== undefined) {
    return (
      <img
        src={source}
        alt=""
        className={cn(
          "shrink-0 rounded-md border-2 border-border [image-rendering:pixelated]",
          className,
        )}
      />
    );
  }

  return <PixelAvatar variant={variantOf(expertId)} className={className} />;
}
