# Plano — Avatares 8-bit dos experts

- **Status:** em implementação (pendente: geração real dos 7 PNGs com `gpt-image-2`, sem `OPENAI_API_KEY` na execução orquestrada; aprovação do Produto/Design)
- **Slug:** 0021-experts-avatars-pixel-art
- **Spec:** `.specs/0021-experts-avatars-pixel-art.md`
- **Data:** 2026-11-17

## Contexto

A 0019 deixou o slot de avatar (`ExpertAvatar`, mapa `AVATAR_IMAGES` vazio, fallback `PixelAvatar`). Falta a arte (7 PNGs), a ferramenta que a gera e a ligação na interface.

## Objetivo

Ferramenta manual `bun run experts:avatars` (Image API `gpt-image-2` + normalização para pixel art), fichas e prompts versionados, mapa `id` → PNG no app (Vite), avatar no estado vazio, no seletor e nas respostas, com fallback quando o arquivo falha.

## Não-objetivos

Geração em tempo de execução, vídeo, animação, logo, upload de avatar, geração no servidor, chamada da API em testes ou CI.

## Requisitos

R1 a R8 da spec. R7 (aprovação) e a parte de R1/R5 que exige os 7 arquivos dependem da geração real, que é manual.

## Decisões e premissas

- Decisão: a ferramenta vira o workspace `packages/experts-avatars` (`@repo/experts-avatars`), com `lint`, `check-types` e `test` no Turborepo; `scripts/experts-avatars.ts` é só a entrada fina chamada pelo comando da raiz. Motivo: `scripts/` não tem tsconfig, tipos nem runner de testes.
- Decisão: sem SDK da OpenAI; `fetch` com `AbortSignal.timeout` atrás de uma interface `ImageClient` (cliente falso nos testes). Evita dependência e facilita o teste.
- Decisão: `pngjs` (JS puro, MIT) só para decodificar a resposta; o PNG final é indexado e escrito por um codificador próprio sobre `node:zlib` (pngjs não grava PNG com paleta). Alternativa descartada: `sharp` (binário nativo, pesado para 7 imagens).
- Decisão: normalização = recorte quadrado central, redução à grade de 48 px por moda de cor do bloco, paleta de até 16 cores (median cut), ampliação por vizinho mais próximo em 3x (144 px), fundo ligado às bordas vira transparente (serve aos dois temas).
- Decisão: o mapa do app usa `import.meta.glob` sobre `src/assets/experts/*.png`; o `id` é o nome do arquivo. Sem arquivo, cai no fallback (estado válido da spec). A API não devolve avatar.
- Decisão: `<select>` nativo não mostra imagem nas opções; o "dropdown" mostra o avatar do expert selecionado ao lado do campo.
- Premissa: tamanho pedido `1024x1024` (`OPENAI_IMAGE_SIZE`), modelo `OPENAI_IMAGE_MODEL` (padrão `gpt-image-2`).
- Premissa: sem chave, os 7 PNGs não são fabricados; o teste de completude roda com `REQUIRE_ALL_AVATARS=1` (obrigatório antes de integrar a arte aprovada).
- ADR: `.adrs/XXXX-0021-avatares-pixel-art-gerados-uma-vez.md`, número provisório (renumerado pelo orquestrador).

## Abordagem (fatias verticais)

1. **Normalização e PNG indexado:** `png.ts`, `normalize.ts` + testes (grade, paleta, quadrado, transparência).
2. **Personagens, prompts e geração:** `characters.ts`, termos proibidos, `image-client.ts`, `generate.ts` (pula existentes, `--force`, falha isolada, escrita atômica, manifesto), `cli.ts`, entrada `scripts/experts-avatars.ts`, comando da raiz + testes com cliente falso.
3. **Interface:** mapa por `import.meta.glob`, fallback em `onError`, avatar ao lado do seletor, testes de componente.
4. **Docs e ADR:** `DESIGN.md` (fichas e checklist), `QA.md`, `AGENTS.md`, `ARCHITECTURE.md`, `.env.example`, ADR.

## Testes

Unitário (vitest) na ferramenta e no app; arquivos dos avatares validados quando existem; nenhum teste chama a OpenAI.

## Riscos e rollback

Saída da IA fora do estilo (revisão humana); custo (geração por expert); rollback: `git revert` (sem migration).

## Critério de pronto

- [x] Lint, tipos, build e testes verdes (baseline `session.service.spec.ts` à parte).
- [x] Interface usa o PNG quando existe e o fallback quando não.
- [ ] 7 PNGs gerados, revisados e aprovados (pendente, fora deste ambiente).

## Histórico de execução

- 2026-11-17: plano criado; execução orquestrada sem `OPENAI_API_KEY`.
- 2026-11-17: fatias 1 a 4 concluídas; falta a geração real dos 7 PNGs (manual, com `OPENAI_API_KEY`) e a aprovação do Produto/Design.
