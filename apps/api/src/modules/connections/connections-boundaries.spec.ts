import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");
const CONNECTIONS_MODULE = join(SRC, "modules", "connections");

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

const shown = (root: string, file: string, target: string) =>
  `${relative(root, file).split(sep).join("/")} -> ${target}`;

describe("connections module boundaries", () => {
  it("keeps domain free of frameworks, SDKs, node built-ins and the other layers", () => {
    const offenders = sourceFiles(join(CONNECTIONS_MODULE, "domain")).flatMap((file) =>
      importsOf(file)
        .filter((target) =>
          /^@nestjs|^@langchain|^pg$|^node:|^weaviate-client|infrastructure|interface|application|observability/.test(
            target,
          ),
        )
        .map((target) => shown(CONNECTIONS_MODULE, file, target)),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps application on domain and the knowledge public surface (no SDK, no infrastructure)", () => {
    const offenders = sourceFiles(join(CONNECTIONS_MODULE, "application")).flatMap((file) =>
      importsOf(file)
        .filter(
          (target) =>
            /^@langchain|^pg$|^node:|^weaviate-client|infrastructure|interface|observability/.test(
              target,
            ) || /knowledge\/(domain|infrastructure|application|interface)/.test(target),
        )
        .map((target) => shown(CONNECTIONS_MODULE, file, target)),
    );

    expect(offenders).toEqual([]);
  });

  it("limits the LangChain Document Loaders to the infrastructure layer", () => {
    const offenders = sourceFiles(CONNECTIONS_MODULE)
      .filter((file) => !file.includes(`${sep}infrastructure${sep}`))
      .flatMap((file) =>
        importsOf(file)
          .filter((target) => /^@langchain|^pdf-parse/.test(target))
          .map((target) => shown(CONNECTIONS_MODULE, file, target)),
      );

    expect(offenders).toEqual([]);
  });

  it("keeps the Gemini SDK in the one infrastructure file that wraps it", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.endsWith(`${sep}infrastructure${sep}gemini-client.ts`))
      .flatMap((file) =>
        importsOf(file)
          .filter((target) => target.startsWith("@google/"))
          .map((target) => shown(SRC, file, target)),
      );

    expect(offenders).toEqual([]);
  });

  it("never reaches for the Weaviate packages (the index is only used through the knowledge port)", () => {
    const offenders = sourceFiles(CONNECTIONS_MODULE).flatMap((file) =>
      importsOf(file)
        .filter((target) => /^weaviate-client|^@langchain\/weaviate/.test(target))
        .map((target) => shown(CONNECTIONS_MODULE, file, target)),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps code outside the module on its public surface (the barrel)", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.startsWith(CONNECTIONS_MODULE))
      .flatMap((file) =>
        importsOf(file)
          .filter((target) =>
            /modules\/connections\/(domain|application|infrastructure|interface)/.test(target),
          )
          .map((target) => shown(SRC, file, target)),
      );

    expect(offenders).toEqual([]);
  });

  it("selects the scripted vision model only for NODE_ENV=test, never anything else (spec 0026)", () => {
    const configSource = readFileSync(
      join(CONNECTIONS_MODULE, "domain", "vision-config.ts"),
      "utf8",
    );
    const fakeSelections = configSource.match(/provider: "fake"/g) ?? [];

    expect(fakeSelections).toHaveLength(2); // the type and the single `test` branch
    expect(configSource).toMatch(/nodeEnv === "test"/);
  });

  it("never reads or logs the bytes or the text of an image in the vision wrappers (spec 0026, R7)", () => {
    const offenders = ["instrumented-image-describer.ts", "image-document-extractor.ts"].filter(
      (name) =>
        /logger|console\.|baseLogger/.test(
          readFileSync(join(CONNECTIONS_MODULE, "infrastructure", name), "utf8"),
        ),
    );

    expect(offenders).toEqual([]);
  });
});
