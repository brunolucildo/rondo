import type { SVGProps } from "react";
import { cn } from "./lib/utils";

/**
 * Pixel-art placeholder for a person's picture: a head and shoulders in the Rondo style, drawn
 * in SVG with `crispEdges`. `K` is the outline (`currentColor`), `P` the face, `S` the shirt and
 * `H` the hair. The `variant` picks one of a few brand-color shirts, so neighbours in a list look
 * different. It is decorative (`aria-hidden`): the name always sits next to it in text.
 */
const GRID = [
  "....KKKKKK....",
  "...KHHHHHHK...",
  "..KHHHHHHHHK..",
  "..KHPPPPPPHK..",
  "..KPPKPPKPPK..",
  "..KPPPPPPPPK..",
  "...KPPKKPPK...",
  "....KPPPPK....",
  "...KKKPPKKK...",
  ".KKSSSKKSSSKK.",
  "KSSSSSSSSSSSSK",
  "KSSSSSSSSSSSSK",
  "KSSSSSSSSSSSSK",
  "KKKKKKKKKKKKKK",
] as const;

const SHIRTS = [
  "var(--color-blaze-orange)",
  "var(--color-golden-glow)",
  "var(--color-lime-moss)",
  "var(--color-sunflower-gold)",
  "var(--color-forest-moss)",
] as const;

const FACE = "var(--color-paper)";
const HAIR = "var(--color-ink)";

type Cell = "K" | "P" | "S" | "H";

interface Run {
  x: number;
  y: number;
  width: number;
  cell: Cell;
}

function isCell(value: string): value is Cell {
  return value === "K" || value === "P" || value === "S" || value === "H";
}

/** Merges neighbouring cells of one letter in a row into a single run. */
const RUNS: readonly Run[] = GRID.flatMap((row, y) => {
  const runs: Run[] = [];
  let current: Run | null = null;

  for (let x = 0; x <= row.length; x += 1) {
    const char = row[x] ?? ".";
    const cell = isCell(char) ? char : null;

    if (current !== null && cell === current.cell) {
      current.width += 1;
      continue;
    }

    if (current !== null) {
      runs.push(current);
      current = null;
    }

    if (cell !== null) {
      current = { x, y, width: 1, cell };
    }
  }

  return runs;
});

export interface PixelAvatarProps extends Omit<
  SVGProps<SVGSVGElement>,
  "children" | "viewBox" | "role" | "aria-hidden"
> {
  /** Picks the shirt color: the same number always gives the same avatar. */
  variant?: number;
}

export function PixelAvatar({ variant = 0, className, ...props }: PixelAvatarProps) {
  const shirt = SHIRTS[Math.abs(Math.trunc(variant)) % SHIRTS.length] ?? SHIRTS[0];
  const fills: Record<Cell, string> = { K: "currentColor", P: FACE, S: shirt, H: HAIR };

  return (
    <svg
      data-slot="pixel-avatar"
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${GRID[0].length} ${GRID.length}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0 text-foreground", className)}
      {...props}
    >
      {RUNS.map((run) => (
        <rect
          key={`${run.x}-${run.y}`}
          x={run.x}
          y={run.y}
          width={run.width}
          height={1}
          style={{ fill: fills[run.cell] }}
        />
      ))}
    </svg>
  );
}
