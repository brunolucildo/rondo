import type { SVGProps } from "react";

/**
 * Pixel-art icon set (DESIGN.md §4). Every icon is drawn on a character grid and rendered as
 * merged `<rect>`s with `crispEdges`. `K` is the outline and takes `currentColor`; the other
 * letters are fixed fills. Icons are decorative (`aria-hidden`): the meaning is always in text.
 */

const FILLS = {
  K: "currentColor",
  R: "var(--destructive)",
  Y: "var(--color-golden-glow)",
  G: "var(--color-sunflower-gold)",
  P: "var(--color-paper)",
  N: "var(--color-ink)",
  L: "var(--color-lime-moss)",
} as const;

type Cell = keyof typeof FILLS;

export type PixelIconProps = Omit<
  SVGProps<SVGSVGElement>,
  "children" | "viewBox" | "role" | "aria-hidden"
>;

function isCell(value: string): value is Cell {
  return value in FILLS;
}

interface Run {
  x: number;
  y: number;
  width: number;
  cell: Cell;
}

/** Merges neighbouring cells of one letter in a row into a single run. */
function runsOf(grid: readonly string[]): Run[] {
  const runs: Run[] = [];

  grid.forEach((row, y) => {
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
  });

  return runs;
}

function drawIcon(grid: readonly string[]) {
  const width = Math.max(...grid.map((row) => row.length));
  const runs = runsOf(grid);

  return function Icon(props: PixelIconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${width} ${grid.length}`}
        shapeRendering="crispEdges"
        aria-hidden="true"
        focusable="false"
        {...props}
      >
        {runs.map((run) => (
          <rect
            key={`${run.x}-${run.y}`}
            x={run.x}
            y={run.y}
            width={run.width}
            height={1}
            style={{ fill: FILLS[run.cell] }}
          />
        ))}
      </svg>
    );
  };
}

/** Eye (12 x 8): shows a password. */
export const EyeIcon = drawIcon([
  "..KKKKKKKK..",
  ".K........K.",
  "K....KK....K",
  "K...KKKK...K",
  "K...KKKK...K",
  "K....KK....K",
  ".K........K.",
  "..KKKKKKKK..",
]);

/** The eye crossed by a diagonal: hides a password. */
export const EyeOffIcon = drawIcon([
  "..KKKKKKKK..",
  ".K.K......K.",
  "K...K.KK...K",
  "K...KKKK...K",
  "K...KKKK...K",
  "K....KK.K..K",
  ".K.....K.K..",
  "..KKKKKKKK..",
]);

/** Sun (11 x 11): the light theme. */
export const SunIcon = drawIcon([
  ".....K.....",
  ".K...K...K.",
  "..K.....K..",
  "...KKKKK...",
  "...KKKKK...",
  "KK.KKKKK.KK",
  "...KKKKK...",
  "...KKKKK...",
  "..K.....K..",
  ".K...K...K.",
  ".....K.....",
]);

/** Crescent moon (11 x 11): the dark theme. */
export const MoonIcon = drawIcon([
  "....KKKK...",
  "..KKKK.....",
  ".KKKK......",
  ".KKK.......",
  "KKKK.......",
  "KKKK.......",
  "KKKK.......",
  ".KKK.......",
  ".KKKK....KK",
  "..KKKKKKKKK",
  "....KKKKK..",
]);

/** Red card (10 x 12): an error. */
export const RedCardIcon = drawIcon([
  ".KKKKKKKK.",
  "KRRRRRRRRK",
  "KRRRRRRRRK",
  "KRRRRRRRRK",
  "KRRRRRRRRK",
  "KRRRRRRRRK",
  "KRRRRRRRRK",
  "KRRRRRRRRK",
  "KRRRRRRRRK",
  "KRRRRRRRRK",
  "KRRRRRRRRK",
  ".KKKKKKKK.",
]);

/** Yellow card (10 x 12): a warning. */
export const YellowCardIcon = drawIcon([
  ".KKKKKKKK.",
  "KYYYYYYYYK",
  "KYYYYYYYYK",
  "KYYYYYYYYK",
  "KYYYYYYYYK",
  "KYYYYYYYYK",
  "KYYYYYYYYK",
  "KYYYYYYYYK",
  "KYYYYYYYYK",
  "KYYYYYYYYK",
  "KYYYYYYYYK",
  ".KKKKKKKK.",
]);

/** Ball in the net (12 x 11): a success. */
export const GoalIcon = drawIcon([
  "KKKKKKKKKKKK",
  "K.K.K.K.K.KK",
  "KK.K.KKK.K.K",
  "K.K.KPPPK.KK",
  "KK.KKPNPKK.K",
  "K.K.KPPPK.KK",
  "KK.K.KKK.K.K",
  "K.K.K.K.K.KK",
  "KK.K.K.K.K.K",
  "K.K.K.K.K.KK",
  "KKKKKKKKKKKK",
]);

/** Referee whistle (12 x 11): information. */
export const WhistleIcon = drawIcon([
  "............",
  ".KKKKKKKK...",
  "KGGGGGGGGKK.",
  "KGGGGGGGGGGK",
  "KKKKKKKKKKGK",
  ".........KGK",
  ".....KKK.KGK",
  "....KGGGK.KK",
  "....KGKGK...",
  "....KGGGK...",
  ".....KKK....",
]);

/** Soccer ball (14 x 14), the same drawing as the Rondo logo. */
export const BallIcon = drawIcon([
  "....KKKKKK....",
  "..KKPPPPPPKK..",
  ".KPPPPPPPPPPK.",
  ".KPPPNNNNPPPK.",
  "KPPPNNNNNNPPPK",
  "KPPPNNNNNNPPPK",
  "KPPPPNNNNPPPPK",
  "KPPPPPNNPPPPPK",
  "KPPPPPPPPPPPPK",
  "KPPPPPPPPPPPPK",
  ".KPPPPPPPPPPK.",
  ".KPPPPPPPPPPK.",
  "..KKPPPPPPKK..",
  "....KKKKKK....",
]);
