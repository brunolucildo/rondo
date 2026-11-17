import { PixelAvatar } from "@repo/ui/pixel-avatar";
import { cn } from "@repo/ui/lib/utils";
import { useState } from "react";
import { AVATAR_IMAGES } from "./avatar-images";

export { AVATAR_IMAGES };

/** The same `id` always gets the same placeholder color. */
function variantOf(id: string): number {
  return [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

export interface ExpertAvatarProps {
  expertId: string;
  /** Picture files by id; the default is the app's own map. */
  images?: Readonly<Record<string, string>>;
  /**
   * Empty by default: the expert's name is written next to the avatar, so it is decorative. Give a
   * description only where the picture stands alone.
   */
  alt?: string;
  /**
   * Size classes. Prefer 48 px (`size-12`) or a multiple of it: the picture is a 48 px pixel grid,
   * so other sizes make some pixels wider than others.
   */
  className?: string;
}

/**
 * The expert's picture, sharp (`image-rendering: pixelated`) and with a fixed box, so loading it
 * never moves the layout. If the file is missing or fails to load, the pixel-art placeholder
 * takes its place.
 */
export function ExpertAvatar({
  expertId,
  images = AVATAR_IMAGES,
  alt = "",
  className,
}: ExpertAvatarProps) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = Object.hasOwn(images, expertId) ? images[expertId] : undefined;

  if (source === undefined || source === failedSource) {
    return <PixelAvatar variant={variantOf(expertId)} className={className} />;
  }

  return (
    <img
      src={source}
      alt={alt}
      onError={() => setFailedSource(source)}
      className={cn("shrink-0 object-contain [image-rendering:pixelated]", className)}
    />
  );
}
