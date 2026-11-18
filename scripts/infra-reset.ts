import { assertDocker, run } from "./lib/command";

assertDocker();

console.warn(
  "\nATENCAO: `infra:reset` apaga os volumes locais do Postgres (contas, sessoes e tokens) e do Weaviate (chunks indexados). " +
    "Nenhum dado de um Postgres hospedado e tocado.\n",
);

const downCode = await run("docker compose down -v (apaga os volumes do Postgres e do Weaviate)", [
  "docker",
  "compose",
  "down",
  "-v",
  "--remove-orphans",
]);

if (downCode !== 0) {
  process.exit(1);
}

const upCode = await run("docker compose up (recriando Postgres e Weaviate do zero)", [
  process.execPath,
  "run",
  "scripts/infra-up.ts",
]);

if (upCode !== 0) {
  process.exit(1);
}

console.log(
  "\nBanco local e Weaviate recriados e vazios. Rode `bun run db:migrate` para aplicar o schema.",
);
