import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");
const KNOWLEDGE_MODULE = join(SRC, "modules", "knowledge");

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

describe("knowledge module boundaries", () => {
  it("keeps domain free of Weaviate, LangChain, OpenAI, Nest, node:crypto and the other layers (R3)", () => {
    const offenders = sourceFiles(join(KNOWLEDGE_MODULE, "domain")).flatMap((file) =>
      importsOf(file)
        .filter((target) =>
          /^weaviate-client|^@langchain|^openai|^@nestjs|^node:|infrastructure|interface|application|observability/.test(
            target,
          ),
        )
        .map((target) => `${relative(KNOWLEDGE_MODULE, file).split(sep).join("/")} -> ${target}`),
    );

    expect(offenders).toEqual([]);
  });

  it("limits the Weaviate and OpenAI SDKs to the infrastructure layer", () => {
    const offenders = sourceFiles(KNOWLEDGE_MODULE)
      .filter((file) => !file.includes(`${sep}infrastructure${sep}`))
      .flatMap((file) =>
        importsOf(file)
          .filter((target) =>
            /^weaviate-client|^@langchain\/(weaviate|openai)|^openai/.test(target),
          )
          .map((target) => `${relative(KNOWLEDGE_MODULE, file).split(sep).join("/")} -> ${target}`),
      );

    expect(offenders).toEqual([]);
  });

  it("keeps code outside the module on its public surface (barrel or testing)", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.startsWith(KNOWLEDGE_MODULE))
      .flatMap((file) =>
        importsOf(file)
          .filter((target) =>
            /modules\/knowledge\/(domain|application|infrastructure|interface)/.test(target),
          )
          .map((target) => `${relative(SRC, file).split(sep).join("/")} -> ${target}`),
      );

    expect(offenders).toEqual([]);
  });

  it("never imports the Weaviate or OpenAI SDKs outside the knowledge module", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.startsWith(KNOWLEDGE_MODULE))
      .flatMap((file) =>
        importsOf(file)
          .filter((target) => /^weaviate-client|^@langchain\//.test(target))
          .map((target) => `${relative(SRC, file).split(sep).join("/")} -> ${target}`),
      );

    expect(offenders).toEqual([]);
  });
});
