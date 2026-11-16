# 0018 — Dark mode por `data-theme` no `<html>`

- **Status:** aceito
- **Data:** 2026-11-16

## Contexto

`DESIGN_SYSTEM.md` §3.2 dizia que o dark mode "ainda não foi decidido". A spec `0018` decidiu (2026-11-16) que o redesign cobre tema claro e escuro, com preferência do sistema por padrão, alternância manual persistida e **sem flash** de tema errado. Há dois apps com origens diferentes (`apps/app` em Vite e `apps/docs` em Next.js) que compartilham tokens por `@repo/ui`.

## Decisão

O tema vive em `<html data-theme="light|dark">`, sempre resolvido por um script inline antes da primeira pintura (`themeInitScript` em `@repo/ui/theme`): escolha guardada em `localStorage["rondo-theme"]` (com `try/catch`), senão `prefers-color-scheme`. Os tokens semânticos em `packages/ui/src/tokens.css` têm o bloco `:root` (claro) e `:root[data-theme="dark"]` (escuro). O `ThemeToggle` (dois estados) grava o atributo e a escolha, sem recarregar. O logo acompanha o tema por CSS (`tone="auto"`, `--logo-outline` e `--logo-left`). A escolha vale por app, porque as origens são diferentes.

## Alternativas consideradas

| Alternativa                                    | Prós                              | Contras                                                                                          | Por que não                                                    |
| ---------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Só `@media (prefers-color-scheme: dark)`       | Sem JS, sem flash                 | Sem escolha manual; o bloco escuro precisa ser repetido para o atributo                          | A spec exige alternância e persistência                        |
| `light-dark()` em cada token                   | Um bloco só, sem duplicar         | O Lightning CSS do Tailwind pode reescrever a função com um truque de variáveis; suporte recente | Risco de comportamento diferente entre dev e build             |
| Classe `.dark` (padrão shadcn) + `useEffect`   | Convenção conhecida               | Sem script pré-pintura o tema errado aparece por um quadro                                       | Flash de tema (viola R5)                                       |
| Seletor de três estados (sistema/claro/escuro) | Pessoa volta a "seguir o sistema" | Mais UI e mais estados para testar                                                               | Premissa Q4: dois estados; sem escolha salva já vale o sistema |

## Consequências

- Positivas: sem flash; um único bloco escuro; o mesmo mecanismo no app (Vite) e no docs (Next); falha de `localStorage` não quebra a página; contraste dos dois temas é testado (`apps/app/src/ui/theme-contrast.test.ts`).
- Negativas: sem JavaScript o tema é o claro; o script existe em dois lugares (`index.html` e `@repo/ui/theme`), mantidos iguais por teste; a escolha não é compartilhada entre `apps/app` e `apps/docs`; `suppressHydrationWarning` no `<html>` do docs.
- Impacto: novos componentes usam só tokens semânticos; qualquer cor nova precisa de par claro e escuro e de uma linha na tabela de contraste.
