import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contrast of the semantic token pairs in both themes (DESIGN.md §2.3, WCAG 2.2 AA). It reads
 * `packages/ui/src/tokens.css`, so a changed color that breaks a pair fails here, not by eye.
 * `PRINT_CONTRAST=1 bun run test` prints the table that `DESIGN.md` reproduces.
 */
const CSS = readFileSync(resolve(process.cwd(), "../../packages/ui/src/tokens.css"), "utf8");

function declarations(block: string): Map<string, string> {
  const map = new Map<string, string>();

  for (const match of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    map.set(match[1] as string, (match[2] as string).trim());
  }

  return map;
}

function blockOf(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  const open = CSS.indexOf("{", start);
  const end = CSS.indexOf("\n}", open);

  return CSS.slice(open + 1, end);
}

const LIGHT = declarations(blockOf(":root"));
const DARK = new Map([...LIGHT, ...declarations(blockOf(':root[data-theme="dark"]'))]);

function resolveColor(theme: Map<string, string>, name: string): string {
  let value = theme.get(name);

  for (let depth = 0; depth < 8 && value !== undefined && value.startsWith("var("); depth += 1) {
    value = theme.get(value.slice(4, -1).trim());
  }

  if (value === undefined || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${name} does not resolve to a hex color (got ${String(value)})`);
  }

  return value;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;

    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return (
    0.2126 * (channels[0] as number) +
    0.7152 * (channels[1] as number) +
    0.0722 * (channels[2] as number)
  );
}

function ratio(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [
    number,
    number,
  ];

  return (light + 0.05) / (dark + 0.05);
}

type Pair = readonly [foreground: string, background: string, minimum: number, use: string];

const TEXT = 4.5;
const UI = 3;

const PAIRS: readonly Pair[] = [
  ["--foreground", "--background", TEXT, "Body text on the page"],
  ["--card-foreground", "--card", TEXT, "Text on a card"],
  ["--muted-foreground", "--background", TEXT, "Secondary text on the page"],
  ["--muted-foreground", "--card", TEXT, "Secondary text on a card"],
  ["--foreground", "--muted", TEXT, "Text on a hovered outline button"],
  ["--primary-foreground", "--primary", TEXT, "Primary button label"],
  ["--accent-foreground", "--accent", TEXT, "Hovered primary button and link label"],
  ["--secondary-foreground", "--secondary", TEXT, "Secondary button label, hovered link"],
  ["--destructive", "--background", TEXT, "Field error text on the page"],
  ["--destructive", "--card", TEXT, "Field error text on a card"],
  ["--destructive-foreground", "--destructive", TEXT, "Destructive button label"],
  ["--success-foreground", "--success", TEXT, "Success alert text"],
  ["--warning-foreground", "--warning", TEXT, "Warning alert text"],
  ["--info-foreground", "--info", TEXT, "Info alert text"],
  ["--border", "--background", UI, "Border and input outline on the page"],
  ["--border", "--card", UI, "Border and input outline on a card"],
  ["--input", "--card", UI, "Text field border on a card"],
  ["--ring", "--background", UI, "Focus ring on the page"],
  ["--ring", "--card", UI, "Focus ring on a card"],
  ["--primary", "--background", UI, "Primary button against the page"],
  ["--primary", "--card", UI, "Primary button against a card"],
  ["--destructive", "--card", UI, "Invalid field border and error alert border"],
];

describe.each([
  ["light", LIGHT],
  ["dark", DARK],
] as const)("%s theme contrast", (_name, theme) => {
  it.each(PAIRS)("%s on %s is at least %s:1 (%s)", (foreground, background, minimum) => {
    const value = ratio(resolveColor(theme, foreground), resolveColor(theme, background));

    if (process.env.PRINT_CONTRAST) {
      process.stdout.write(`${_name}\t${foreground}\t${background}\t${value.toFixed(2)}\n`);
    }

    expect(value).toBeGreaterThanOrEqual(minimum);
  });
});

describe("tokens", () => {
  it("keeps hex out of everything but the primitive palette", () => {
    const outsidePrimitives = CSS.split("\n").filter(
      (line) => /#[0-9a-f]{6}/i.test(line) && !/^\s*--color-[\w-]+:\s*#[0-9a-f]{6};/i.test(line),
    );

    expect(outsidePrimitives).toEqual([]);
  });
});
