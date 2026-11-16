# Plano — Redesign da UI: identidade retro 8-bit com futebol

- **Status:** implementado (ver relatório); E2E completo pendente de execução pelo usuário
- **Slug:** 0018-ui-redesign-retro-8bit
- **Spec:** `.specs/0018-ui-redesign-retro-8bit.md`
- **Data:** 2026-11-16

## Contexto

As telas funcionam, mas parecem protótipo: card retangular, fonte do sistema, nenhum ícone, nenhuma referência ao futebol além do logo, sem dark mode. `DESIGN.md` já descreve a direção (arcade/8-bit + futebol); só os tokens e o `Button` foram aplicados. Esta mudança aplica a identidade a todas as telas existentes, sem tocar em comportamento.

## Objetivo

Todas as telas de `apps/app` (`/auth/*`, `/app`, 404, sessão) e a home de `apps/docs` com identidade "Matchday", em tema claro e escuro, com acessibilidade AA, primitivos reutilizáveis no `@repo/ui` e screenshots antes/depois.

## Não-objetivos

Lógica de auth, API, rotas, textos funcionais, i18n, novas telas, ilustração raster, redesenho do logo, e-mails (spec §1, R21).

## Usuários e permissões

Sem mudança. Visitante (`/auth/*`) e pessoa autenticada (`/app`) veem os mesmos fluxos; nenhuma permissão, dado ou chamada de API novos.

## Fluxos e estados

Os da spec §5, inalterados em comportamento: caminho feliz, vazio, carregando (`aria-busy` + bola), erro de campo (texto + ícone, `aria-describedby`), erro geral (`Alert` erro `role="alert"`), sucesso (`Alert` `role="status"`), retry, tema persistido sem recarregar.

## Requisitos

R1–R21 da spec. Critérios de aceite: spec §4 e §6.

## Contratos de dados

Nenhum contrato de API muda. Contrato novo de cliente: `localStorage["rondo-theme"]` = `"light"` | `"dark"` (por app/origem), lido com `try/catch`; `<html data-theme>` resolvido antes da primeira pintura.

## Integrações

Nenhuma. Fontes auto-hospedadas (sem CDN em runtime).

## Decisões e premissas

| #   | Decisão                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | **Aceita.** Corpo em Geist, dados em Geist Mono, só 400 e 700; display em Press Start 2P. Os `.woff2` do subconjunto latino vão em `packages/ui/assets/fonts/` (OFL, com a licença), carregados por `@font-face` em `packages/ui/src/fonts.css` com `font-display: swap`. **Nenhuma dependência npm** de fonte; o `apps/docs` deixa de usar `next/font/local` e os `.woff` completos dele (código morto) são removidos. |
| Q2  | **Aceita.** Captura por interceptação de rede (`scripts/capture-screenshots.mjs`), sem API nem banco.                                                                                                                                                                                                                                                                                                                   |
| Q3  | **Viável sem Tailwind no docs.** Os tokens (primitivos, semânticos claro/escuro, fontes) ficam em `packages/ui/src/tokens.css`, CSS puro; `styles.css` (Tailwind) o importa e o `apps/docs` importa só `@repo/ui/tokens.css` + `@repo/ui/brand`-equivalente por SVG. Elimina o hex duplicado de `globals.css`.                                                                                                          |
| Q4  | **Aceita.** `ThemeToggle` de dois estados; sem escolha vale o sistema; `localStorage` com `try/catch`.                                                                                                                                                                                                                                                                                                                  |
| D1  | **Tema por `data-theme` no `<html>`**, sempre resolvido pelo script pré-pintura (`@repo/ui/theme` exporta o texto do script; `index.html` do app tem a cópia literal e um teste prova que são iguais, como o teste das cópias do logo). O CSS tem `:root` (claro) e `:root[data-theme="dark"]` (escuro), sem bloco duplicado em `@media`. Sem JS o tema é o claro (aceitável: o app é React).                           |
| D2  | **Logo acompanha o tema por CSS**: `tone="auto"` (novo padrão) usa `--logo-outline` e `--logo-left`, que o tema escuro troca (`paper` / `sunflower-gold`), como o logo escuro já faz. `tone="light"` e `"dark"` continuam fixos e o teste de pixels contra os SVG segue valendo.                                                                                                                                        |
| D3  | **Shell de `/app`:** `AppLayout` mostra o cabeçalho (wordmark estendido, `ThemeToggle`, sign-out) **só com sessão válida**; carregando e erro seguem em tela cheia com a marca compacta (DESIGN.md §11.2). Logo, a home deixa de ter a marca compacta no corpo (uma marca por tela) e o `brand.test.tsx` é ajustado para isso.                                                                                          |
| D4  | O `SignOutButton` sai do corpo da home e vai para o cabeçalho; o texto "Sign out" e o comportamento são os mesmos.                                                                                                                                                                                                                                                                                                      |
| D5  | Contraste é **testado**: `apps/app/src/theme-contrast.test.ts` lê `tokens.css`, resolve os pares semânticos dos dois temas e exige ≥ 4,5:1 (texto) e ≥ 3:1 (UI/foco). A tabela de `DESIGN.md` sai desses números.                                                                                                                                                                                                       |
| D6  | `axe` (R16, Should) via `@axe-core/playwright` como devDependency, num E2E de a11y com a API interceptada (sem banco). O E2E **não é executado por mim** (spec §7.9); o código fica pronto e a execução é pedida ao usuário.                                                                                                                                                                                            |
| D7  | Capturas por `scripts/capture-screenshots.mjs` (biblioteca Playwright, pelo terminal), por decisão do usuário: o Playwright MCP não conectou na sessão (`CONNECTION_CLOSED`).                                                                                                                                                                                                                                           |

## Plano de design (skill `frontend-design`)

**Conceito:** "Matchday": cada tela é um pedaço do dia de jogo em 8-bit. Faixa de gramado, linhas de campo, bola, placar, cartões. Quieto onde importa (formulário), ousado em um lugar por tela.

**Paleta (nomeada, 6 hex da marca + neutros derivados):**

| Nome                        | Hex                                                                                                                                 | Papel                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ink`                       | `#0A0A0A`                                                                                                                           | Texto, bordas e sombras no claro; fundo do escuro                     |
| `paper`                     | `#FFFDF5`                                                                                                                           | Fundo claro; texto e bordas no escuro                                 |
| `blaze-orange`              | `#FB6107`                                                                                                                           | Ação primária (sempre texto `ink`)                                    |
| `golden-glow`               | `#F3DE2C`                                                                                                                           | Cartão amarelo (aviso), foco no escuro                                |
| `lime-moss` / `forest-moss` | `#7CB518` / `#5C8001`                                                                                                               | Gramado do campo; sucesso (lime); foco no claro (forest)              |
| `sunflower-gold`            | `#FBB02D`                                                                                                                           | Hover, acento                                                         |
| neutros novos               | `night #0F0F0C`, `night-raised #1B1B16`, `paper-shade #F1EDE1`, `chalk-muted #B5B1A0`, `card-red #B91C1C`, `card-red-light #F87171` | Superfícies e texto secundário do escuro; erro legível nos dois temas |

**Tipografia:** títulos curtos em Press Start 2P (mínimo 16px; escala 16/20/24/32 px, uma linha curta, `text-wrap: balance`, títulos longos em 16–20px); corpo e interface em Geist 16px; dados e código em Geist Mono. Fallback `ui-monospace` para display e `system-ui` para o corpo.

**Princípios:** formas duras (raio 0–4px), borda de 2px, sombra deslocada de 4px (2px no botão), grade de 4px, ícones em grade 12×12 / 16×16 com `crispEdges`, movimento só em `steps()` e ≤ 300ms, cor nunca é o único sinal (cada aviso tem ícone e texto).

**Layout (wireframes):**

```text
/auth/* ≥ 1024px                                  /auth/* < 1024px
┌───────────────────────────┬──────────────────┐  ┌──────────────────────┐
│ ▓▓░░▓▓░░▓▓░░ campo pixel  │ [RONDO]   [☼/☾] │  │ ▓▓░░▓▓░░ faixa 112px │
│ ░░  ┌──────┐  ░░          │                  │  ├──────────────────────┤
│ ▓▓  │ (●)  │  ▓▓  campo   │ ┌──────────────┐ │  │ [RONDO]      [☼/☾]  │
│ ░░  └──────┘  ░░          │ │ Título       │ │  │ ┌──────────────────┐ │
│ "Club knowledge,          │ │ form / aviso │ │  │ │ card do form     │ │
│  in play."                │ └──────────────┘ │  │ └──────────────────┘ │
└───────────────────────────┴──────────────────┘  └──────────────────────┘
/app (com sessão)                                  404
┌────────────────────────────────────────────┐    ┌──────────────────────┐
│ [RONDO]                    [☼/☾] [Sign out]│    │ [mark]               │
├────────────────────────────────────────────┤    │ 404 (display)        │
│ Welcome, Alex (display)                    │    │ Page not found       │
│ You are signed in.        ┌formação 4-3-3┐ │    │ texto  [Go to home]  │
└────────────────────────────────────────────┘    └──────────────────────┘
```

**Uma ousadia por tela:** auth = campo pixel; home = formação 4-3-3 decorativa; 404 = placar "404" e "Offside" decorativo. Cartões: vermelho (erro), amarelo (aviso), bola na rede (sucesso), apito (info), sempre ícone + texto.

**Revisão "isto é um default?":** card branco com borda e sombra preta sobre fundo liso era o default; sai. Fontes do sistema saem. Botão laranja sozinho não basta: ganha sombra de arcade, estado `active` que afunda e foco em anel de duas cores. Se algo ainda parecer template após os screenshots, a autocrítica do passo 8 corrige.

## Abordagem (fatias verticais)

1. **Fundação:** `tokens.css` (primitivos, semânticos claro/escuro, fontes, sombras, movimento), `fonts.css` e fontes, `styles.css` ajustado, `theme.ts` (script, chaves, helpers), `ThemeToggle`, script pré-pintura em `index.html` e `layout.tsx` do docs, logo `tone="auto"`. Teste de contraste.
2. **Primitivos:** `icons` (pixel: olho, sol, lua, cartão vermelho/amarelo, bola na rede, apito, bola, formação), `Spinner`, `Card`, `Alert`, `FieldBackdrop`, `Field` (R17), restilização de `Button`/`Input`/`Label`/`PasswordInput`. Testes e exports.
3. **Auth:** `AuthLayout` (campo + card + `ThemeToggle`, wordmark uma vez) e as seis páginas com `Card`, `Alert`, `Field`, `Spinner`.
4. **App:** `AppLayout` com cabeçalho, home "vestiário", `NotFoundPage`, `SessionLoading`, `SessionError`.
5. **Docs:** tokens, fonte, tema e logo na página inicial.
6. **Qualidade:** `web-design-guidelines`, contraste, teclado, 320px, zoom 200%, movimento reduzido, E2E de a11y (escrito, não executado).
7. **Capturas `_after`**, README, autocrítica.
8. **Docs e ADRs** (0018 dark mode, 0019 fonte display), gates, commit.

## Arquivos previstos

`packages/ui/src/{tokens.css,fonts.css,styles.css,theme.ts,theme-toggle.tsx,icons.tsx,spinner.tsx,card.tsx,alert.tsx,field.tsx,field-backdrop.tsx,button.tsx,input.tsx,label.tsx,password-input.tsx,brand.tsx}` (+ testes em `apps/app/src/ui/` porque `@repo/ui` não tem runner), `packages/ui/assets/fonts/*`, `packages/ui/package.json`; `apps/app/{index.html,src/index.css,src/routes/*,src/features/auth/*-page.tsx,session-states.tsx,sign-out-button.tsx}`; `apps/docs/app/{layout.tsx,globals.css,page.tsx,page.module.css}`, `apps/docs/package.json`; `e2e/a11y.spec.ts`; `.mcp.json`, `scripts/capture-screenshots.mjs`, `.screenshots/*`; `.docs/{DESIGN,DESIGN_SYSTEM,QA,ARCHITECTURE}.md`; `.adrs/0018-*.md`, `.adrs/0019-*.md`.

## Testes

- Unitários dos primitivos (variantes, estados, `className`, papéis `role`/`aria-*`): `apps/app/src/ui/*.test.tsx`.
- Tema: script pré-pintura (claro/escuro/sem `localStorage`/valor inválido), `ThemeToggle` (alterna e persiste, `try/catch`), cópia do script em `index.html` igual à de `@repo/ui/theme`.
- Contraste dos pares dos dois temas (`theme-contrast.test.ts`).
- As suítes existentes de cada página e `brand.test.tsx` continuam; ajustes só onde a marcação mudou, justificados abaixo.
- E2E de acessibilidade com `axe` nos dois temas (R16): escrito; execução pedida ao usuário.
- Verificação manual: 320/375/768/1280, teclado, zoom 200%, movimento reduzido, console.

**Seletores/asserções que mudam (justificativa):** `brand.test.tsx` (home passa a ter o wordmark no cabeçalho e não a marca compacta no corpo, D3). Demais testes de página usam papéis e textos, que não mudam.

## Riscos e rollback

Spec §9. Rollback: reverter o commit; nenhuma migration, dado ou contrato é afetado. Risco novo: `light-dark()` foi descartada por o Tailwind/Lightning CSS poder reescrevê-la; o tema usa atributo + dois blocos.

## Critério de pronto

Spec §6 inteira; `bun run lint`, `check-types`, `test`, `build` verdes; `apps/api` e `db/` sem diff; `.screenshots/` com todos os pares; `DESIGN.md` com a tabela de contraste real.

## Perguntas abertas

Nenhuma bloqueante. Premissas Q1–Q7 da spec aceitas; Q7 vale: `axe` entra como devDependency.

## Resultado da implementação

- `web-design-guidelines`: achados corrigidos (`spellCheck` nos e-mails, `touch-manipulation`, transição só de `transform`); não aplicados com motivo (`theme-color`, `preload` das fontes, Title Case dos textos funcionais). Detalhes em `.docs/QA.md` §1.11.
- Divergências do plano: o formatador reescreve o script pré-pintura, então `themeInitScript` já termina cada instrução em `;` e o teste compara ignorando espaços; `FieldBackdrop` ganhou a prop `ball` para a tira larga do docs; `docs` usa Tailwind (decisão D-docs, em vez de CSS puro) para reutilizar `ThemeToggle`, `Card` e o campo.
- Dívida de outra área: 3 testes de `apps/api` (`session.service.spec.ts`) falham por data fixa; `apps/api` não foi alterado.
