import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");
const EXPERTS_MODULE = join(SRC, "modules", "experts");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }

    return path.endsWith(".ts") && !path.endsWith(".spec.ts") ? [path] : [];
  });
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");

  return [...source.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("experts module boundaries (R6, R12)", () => {
  it("keeps LangChain and LangGraph inside the infrastructure layer", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.includes(`${sep}infrastructure${sep}`))
      .flatMap((file) =>
        importsOf(file)
          .filter((target) => /^(@langchain\/|langchain)/.test(target))
          .map((target) => `${relative(SRC, file)} -> ${target}`),
      );

    expect(offenders).toEqual([]);
  });

  it("keeps domain and application free of framework and infrastructure imports", () => {
    const offenders = ["domain", "application"].flatMap((layer) =>
      sourceFiles(join(EXPERTS_MODULE, layer)).flatMap((file) =>
        importsOf(file)
          .filter((target) =>
            /^@nestjs|^@langchain|infrastructure|interface|observability/.test(target),
          )
          .map((target) => `${relative(EXPERTS_MODULE, file).split(sep).join("/")} -> ${target}`),
      ),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps other modules away from the internals of the experts module", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.startsWith(EXPERTS_MODULE))
      .flatMap((file) =>
        importsOf(file)
          .filter((target) =>
            /modules\/experts\/(domain|application|infrastructure|interface)/.test(target),
          )
          .map((target) => `${relative(SRC, file)} -> ${target}`),
      );

    expect(offenders).toEqual([]);
  });

  it("selects the fake model only for NODE_ENV=test, never anything else", () => {
    const configSource = readFileSync(
      join(EXPERTS_MODULE, "domain", "expert-chat-config.ts"),
      "utf8",
    );
    const fakeSelections = configSource.match(/provider: "fake"/g) ?? [];

    expect(fakeSelections).toHaveLength(2); // the type and the single `test` branch
    expect(configSource).toMatch(/nodeEnv === "test"/);
  });
});
