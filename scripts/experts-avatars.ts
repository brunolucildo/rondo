import { main } from "../packages/experts-avatars/src/cli.ts";

/**
 * Entrada de `bun run experts:avatars`. Gera, a mao e uma vez, os avatares pixel art dos experts
 * com a Image API da OpenAI. A logica e os testes ficam em `packages/experts-avatars`.
 */
const controller = new AbortController();

process.on("SIGINT", () => controller.abort());

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  signal: controller.signal,
});
