# 0019 — Fonte display Press Start 2P e fontes auto-hospedadas

- **Status:** aceito
- **Data:** 2026-11-16

## Contexto

`DESIGN.md` §3 pedia uma fonte display pixel e deixava a escolha em aberto (Press Start 2P ou Silkscreen). A spec `0018` decidiu por **Press Start 2P**. O `apps/app` usava a fonte do sistema e o `apps/docs` usava Geist por `next/font/local` (arquivos `.woff` completos). Os dois apps precisam das mesmas fontes, sem CDN em runtime e com fallback legível.

## Decisão

- **Display:** Press Start 2P, só em títulos curtos e números de placar, nunca abaixo de 16px nem em parágrafos.
- **Corpo e dados:** Geist (sans) e Geist Mono, variáveis, só no subconjunto latino.
- **Hospedagem:** os `.woff2` ficam em `packages/ui/assets/fonts/` (com as licenças OFL) e são declarados por `@font-face` em `packages/ui/src/fonts.css`, com `font-display: swap`, importado por `tokens.css`. Nenhuma dependência npm de fonte; nada vem de CDN.
- **`apps/docs`** passa a consumir `@repo/ui` (tokens, primitivos, tema) com Tailwind v4 por `@tailwindcss/postcss` e `transpilePackages: ["@repo/ui"]`, e deixa de usar `next/font/local` (os `.woff` antigos foram removidos).
- **Acessibilidade automatizada:** `@axe-core/playwright` entra como devDependency da raiz para o E2E de acessibilidade (spec `0018`, R16).

## Alternativas consideradas

| Alternativa                                | Prós                                      | Contras                                                            | Por que não                                                      |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Pacotes `@fontsource/*` como dependência   | Atualização por npm; subconjuntos prontos | 3 dependências; `url()` dentro de `node_modules` nos dois bundlers | Os arquivos mudam raramente; copiar é mais simples e verificável |
| `next/font` no docs e `@fontsource` no app | Otimização nativa do Next                 | Duas formas de carregar a mesma fonte; fontes divergentes          | A identidade deve ser uma só                                     |
| Google Fonts por CDN                       | Zero arquivos                             | Requisição a terceiros; privacidade e disponibilidade              | A spec proíbe CDN em runtime                                     |
| Silkscreen como display                    | Mais compacta                             | Decisão do Produto já foi Press Start 2P                           | Decidido em 2026-11-16                                           |

## Consequências

- Positivas: uma só definição de fontes, tokens e tema para os dois apps; sem requisição externa; `apps/docs` sem hex duplicado.
- Negativas: ~65 KB de fontes no repositório; Press Start 2P é larga e exige títulos curtos e `text-wrap: balance`; as fontes não são pré-carregadas (`swap` mostra a fallback primeiro, e a troca pode mover o texto por um instante).
- Impacto: `apps/docs` ganha `@repo/ui`, `tailwindcss` e `@tailwindcss/postcss`; a raiz ganha `@axe-core/playwright`; licenças OFL ficam em `packages/ui/assets/fonts/`.
