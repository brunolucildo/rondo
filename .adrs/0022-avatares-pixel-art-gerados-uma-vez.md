# 0022 — Avatares dos experts gerados uma vez por uma ferramenta de desenvolvimento

- **Status:** aceito
- **Data:** 2026-11-17
- **Spec:** `0021-experts-avatars-pixel-art`

## Contexto

Cada expert tem um personagem fictício (spec `0019`) e a interface precisa de uma imagem pixel art 8-bit para ele. A imagem é um asset, não conteúdo dinâmico. A spec escolhe o `gpt-image-2` (Image API da OpenAI) para gerar as sete imagens uma única vez, com revisão humana.

## Decisão

1. **A geração é uma ferramenta manual de desenvolvimento**, `bun run experts:avatars` (`scripts/experts-avatars.ts`), que nunca roda no servidor, em CI nem nos testes. Sem a flag `--expert <id>` ou `--all`, ou sem `OPENAI_API_KEY`, não há chamada de rede. As imagens geradas entram no repositório como PNG (`apps/app/src/assets/experts/<id>.png`) com um `manifest.json` (modelo, tamanho, data, hash do prompt).
2. **A ferramenta é um workspace**, `packages/experts-avatars` (`@repo/experts-avatars`, privado): fichas e prompts (`characters.ts`), cliente da Image API atrás de uma interface `ImageClient`, normalização, geração em lote e CLI. A razão é o repositório não ter tipos, lint nem runner de testes para `scripts/`; como workspace, a ferramenta entra em `lint`, `check-types` e `test` do Turborepo. `scripts/experts-avatars.ts` é só a entrada fina.
3. **Sem SDK da OpenAI:** `fetch` com `AbortSignal` (60 s por imagem, uma nova tentativa em timeout, 429 e 5xx; bloqueio de política não repete). Um cliente falso cobre os testes.
4. **Normalização própria**, porque a saída do modelo não é pixel art de verdade: recorte quadrado central, redução a uma grade de 48 px (cor mais frequente do bloco), paleta de até 16 cores (median cut), ampliação por vizinho mais próximo para 144 px e transparência para o fundo ligado à borda (serve ao tema claro e ao escuro). O PNG final é indexado (cabe em poucos KB).
5. **O app resolve o avatar pelo `id`** com `import.meta.glob` sobre `assets/experts/*.png` (o Vite gera o nome com hash). A API não devolve avatar. Sem arquivo, ou se ele falhar ao carregar, a interface usa o fallback pixel da `0019`.

## Alternativas consideradas

| Alternativa                                 | Prós                   | Contras                                                 | Por que não                                                       |
| ------------------------------------------- | ---------------------- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| Gerar a imagem em tempo de execução         | Personagem sob demanda | Custo, dependência do provedor, sem revisão humana      | Backlog; os avatares são assets                                   |
| Script solto em `scripts/`, sem workspace   | Sem pacote novo        | Sem tipos, lint nem testes no Turborepo                 | A lógica (normalização, falhas, `--force`) precisa de testes      |
| SDK `openai`                                | Cliente pronto         | Dependência pesada para uma chamada                     | `fetch` e uma interface bastam e facilitam o cliente falso        |
| `sharp` para decodificar e reduzir a imagem | Rápido, completo       | Binário nativo (instalação, plataformas) para 7 imagens | `pngjs` (JS puro) basta; o PNG indexado é escrito com `node:zlib` |
| Servir o avatar pela API (`avatar` no JSON) | Um só ponto de verdade | A API não conhece o nome com hash do build do Vite      | Decisão da spec: o app mapeia `id` para imagem                    |

## Consequências

- Positivas: arte reproduzível (prompts e manifesto versionados), sem dependência do provedor em produção, ferramenta testada sem rede.
- Negativas: um workspace e uma dependência (`pngjs`) a mais; a qualidade da arte depende de revisão humana e de iterar o prompt; a geração real exige uma chave e é manual.
- Impacto: `ARCHITECTURE.md` (pacotes), `DESIGN.md` (fichas dos personagens e checklist), `QA.md`, `AGENTS.md` (comando), `.env.example` (`OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_SIZE`).
