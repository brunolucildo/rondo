import type { SVGProps } from "react";
import { BallIcon } from "./icons";
import { cn } from "./lib/utils";

/**
 * Pixel-art football decoration (DESIGN.md §4): a pitch with stripes, lines and a ball, and a
 * 4-3-3 formation. Both are drawn in SVG with `crispEdges`, use only brand colors from the
 * tokens, and are decorative (`aria-hidden`). Nothing in them is content.
 */

type SvgProps = Omit<SVGProps<SVGSVGElement>, "children" | "viewBox" | "role" | "aria-hidden">;

const WIDTH = 96;
const HEIGHT = 60;
const STRIPE = 12;
const LINE = "var(--field-line)";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The four 1-unit sides of a rectangle outline. */
function outline({ x, y, width, height }: Box): Box[] {
  return [
    { x, y, width, height: 1 },
    { x, y: y + height - 1, width, height: 1 },
    { x, y, width: 1, height },
    { x: x + width - 1, y, width: 1, height },
  ];
}

/** Cells whose distance from the center rounds to the radius: a pixel circle line. */
function ring(centerX: number, centerY: number, radius: number): Box[] {
  const cells: Box[] = [];

  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (Math.round(Math.hypot(dx, dy)) === radius) {
        cells.push({ x: centerX + dx, y: centerY + dy, width: 1, height: 1 });
      }
    }
  }

  return cells;
}

const STRIPES = Array.from({ length: WIDTH / STRIPE }, (_, index) => ({
  x: index * STRIPE,
  fill: index % 2 === 0 ? "var(--field-grass-a)" : "var(--field-grass-b)",
}));

const LINES: Box[] = [
  ...outline({ x: 3, y: 3, width: WIDTH - 6, height: HEIGHT - 6 }),
  { x: WIDTH / 2 - 1, y: 3, width: 2, height: HEIGHT - 6 },
  ...outline({ x: 3, y: 18, width: 14, height: 24 }),
  ...outline({ x: WIDTH - 17, y: 18, width: 14, height: 24 }),
  ...ring(WIDTH / 2, HEIGHT / 2, 12),
];

/**
 * Pitch seen from above, the visual of the `/auth` layout. It fills its box (`slice`), so on a
 * short strip it shows the middle of the field. The ball arrives with a single short kick
 * (`animate-kick`, 280ms, off with reduced motion).
 */
export interface FieldBackdropProps extends SvgProps {
  /** Draws the ball at the center. Turn it off for wide, short strips that crop the middle. */
  ball?: boolean;
}

export function FieldBackdrop({ className, ball = true, ...props }: FieldBackdropProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      className={cn("block size-full", className)}
      {...props}
    >
      {STRIPES.map((stripe) => (
        <rect
          key={stripe.x}
          x={stripe.x}
          y={0}
          width={STRIPE}
          height={HEIGHT}
          style={{ fill: stripe.fill }}
        />
      ))}
      {LINES.map((box) => (
        <rect
          key={`${box.x}-${box.y}-${box.width}-${box.height}`}
          {...box}
          style={{ fill: LINE }}
        />
      ))}
      {ball ? (
        // The ball outline stays ink in both themes: it sits on grass, not on the page background.
        <g
          className="animate-kick motion-reduce:animate-none"
          style={{ color: "var(--color-ink)" }}
        >
          <BallIcon x={WIDTH / 2 - 7} y={HEIGHT / 2 - 7} width={14} height={14} />
        </g>
      ) : null}
    </svg>
  );
}

/** Player position, in the 48 x 64 grid of the formation. */
const PLAYERS: ReadonlyArray<readonly [number, number, "keeper" | "field"]> = [
  [24, 56, "keeper"],
  [7, 44, "field"],
  [18, 46, "field"],
  [30, 46, "field"],
  [41, 44, "field"],
  [12, 30, "field"],
  [24, 28, "field"],
  [36, 30, "field"],
  [9, 14, "field"],
  [24, 10, "field"],
  [39, 14, "field"],
];

const FORMATION_LINES: Box[] = [
  ...outline({ x: 2, y: 2, width: 44, height: 60 }),
  { x: 2, y: 31, width: 44, height: 1 },
  ...outline({ x: 12, y: 2, width: 24, height: 10 }),
  ...outline({ x: 12, y: 52, width: 24, height: 10 }),
];

/** 4-3-3 formation on a small portrait pitch: the decoration of the signed-in home. */
export function PixelFormation({ className, ...props }: SvgProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 64"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      className={cn("block", className)}
      {...props}
    >
      {[0, 1, 2, 3].map((index) => (
        <rect
          key={index}
          x={0}
          y={index * 16}
          width={48}
          height={16}
          style={{ fill: index % 2 === 0 ? "var(--field-grass-a)" : "var(--field-grass-b)" }}
        />
      ))}
      {FORMATION_LINES.map((box) => (
        <rect
          key={`${box.x}-${box.y}-${box.width}-${box.height}`}
          {...box}
          style={{ fill: LINE }}
        />
      ))}
      {PLAYERS.map(([x, y, role]) => (
        <g key={`${x}-${y}`}>
          <rect x={x - 3} y={y - 3} width={6} height={6} style={{ fill: "var(--color-ink)" }} />
          <rect
            x={x - 2}
            y={y - 2}
            width={4}
            height={4}
            style={{
              fill: role === "keeper" ? "var(--color-golden-glow)" : "var(--color-blaze-orange)",
            }}
          />
        </g>
      ))}
    </svg>
  );
}
