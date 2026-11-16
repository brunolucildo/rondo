# Design System

> **Público:** quem cria ou altera componentes de UI.
> **Obrigatório** em conjunto com `DESIGN.md`.
> **Estado:** identidade retro 8-bit aplicada (spec `0018`). `packages/ui` tem Tailwind v4, shadcn, tokens em dois temas, fontes auto-hospedadas e os primitivos da §5. `apps/app` e `apps/docs` consomem o mesmo pacote.

## 1. Decisão

O design system é construído sobre **shadcn/ui** com **TailwindCSS v4 (CSS-first)**, dentro de `packages/ui`, e consumido pelos apps via `@repo/ui/*`.

| Item                 | Estado                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Estilo               | Tailwind v4; `@tailwindcss/vite` em `apps/app`; sem `tailwind.config` (`components.json` com `config: ""`)                     |
| Componentes base     | `Button`, `Input`, `Label`, `PasswordInput`, `Card`, `Alert`, `Field`, `Spinner`, `ThemeToggle`, ícones e campo em pixel (§5)  |
| Tokens               | Primitivos e semânticos (claro e escuro) em `packages/ui/src/tokens.css` (CSS puro); `styles.css` o importa e liga ao Tailwind |
| Fontes               | Press Start 2P, Geist e Geist Mono auto-hospedadas (`assets/fonts/`, `fonts.css`; ADR `0019`)                                  |
| Tema                 | `data-theme` no `<html>`, script pré-pintura e `ThemeToggle` (`theme.ts`; ADR `0018`)                                          |
| Local dos primitivos | `packages/ui/src`                                                                                                              |
| Utilitários          | `cn()` em `packages/ui/src/lib/utils.ts` (`clsx` + `tailwind-merge`)                                                           |

Ao instalar ou mudar algo, atualize esta tabela, `ARCHITECTURE.md` e `QA.md` na mesma mudança.

## 2. Onde cada componente vive

| Tipo                       | Local                                         | Exemplo                                 |
| -------------------------- | --------------------------------------------- | --------------------------------------- |
| Primitivo reutilizável     | `packages/ui/src/<componente>.tsx`            | `button.tsx`, `input.tsx`, `dialog.tsx` |
| Composição de uma feature  | `apps/app/src/features/<dominio>/components/` | `expert-card.tsx`                       |
| Composição raiz            | `apps/app/src/`                               | `App.tsx`, `main.tsx`                   |
| Utilitário de apresentação | `packages/ui/src/lib/` ou `apps/app/src/lib/` | `utils.ts` (`cn`)                       |

Regras:

- Se o componente é usado por mais de um app ou por mais de uma feature, ele pertence a `packages/ui`.
- Se depende de uma regra de negócio ou de uma chamada de API, ele **não** pertence a `packages/ui`.
- O contrato de exports é **explícito**: hoje `./alert`, `./brand`, `./button`, `./card`, `./field`, `./icons`, `./input`, `./label`, `./password-input`, `./pitch`, `./spinner`, `./styles.css`, `./theme`, `./theme-toggle`, `./tokens.css` e `./lib/utils` (mapa `exports` do `package.json`). Todo novo primitivo precisa de uma entrada nesse mapa na mesma mudança; imports de caminhos não exportados falham.
- Um app que usa `@repo/ui` importa `@repo/ui/styles.css` e precisa que o Tailwind enxergue `packages/ui/src` (`@source "./"` já está em `styles.css`). Um consumidor sem Tailwind importa só `@repo/ui/tokens.css`. Um app Next.js ainda precisa de `transpilePackages: ["@repo/ui"]`.

## 3. Tokens

### 3.1 Camadas

```text
primitivos (paleta bruta)
  → semânticos (background, foreground, primary, muted, border, focus)
    → componentes (button, card, badge)
```

- **Primitivos:** os hex de `DESIGN.md` (`--color-blaze-orange`, etc.) e os neutros derivados dos temas, só em `tokens.css`.
- **Semânticos:** nomes no padrão shadcn (`--background`, `--foreground`, `--primary`, `--primary-foreground`, `--muted`, `--border`, `--ring`) mais `--success`, `--warning`, `--info` (cada um com `-foreground`) e `--shadow-color`. Cada token tem valor claro (`:root`) e escuro (`:root[data-theme="dark"]`).
- **Componentes:** não definem hex; consomem semânticos.

### 3.2 Regras

1. Hex só aparece na definição dos primitivos.
2. Componente nunca escolhe cor "no olho"; usa token semântico.
3. Todo par texto/fundo precisa passar o contraste definido em `DESIGN.md`.
4. **Dark mode** existe (ADR `0018`): o tema vem de `<html data-theme>`. Componente nunca testa o tema; usa token semântico. Uma cor nova precisa de par claro e escuro e passa no teste de contraste (`DESIGN.md` §2.5).
5. Espaçamento (escala de 4px do Tailwind), raio (`--radius`, 4px), sombra (`shadow-pixel`, `shadow-pixel-sm`), movimento (`ease-pixel`, `animate-pixel-spin`, `animate-kick`) e fontes (`font-display`, `font-sans`, `font-mono`) também são tokens, não valores soltos repetidos.

## 4. Contrato de componentes

Todo primitivo deve:

- Aceitar `className` e permitir composição.
- Expor variantes explícitas (ex.: `variant`, `size`) em vez de flags booleanas proliferadas.
- Ter estados documentados: default, hover, focus-visible, active, disabled, loading, error (quando aplicável).
- Ser acessível: elemento semântico correto, label, `aria-*` quando necessário, foco visível.
- Funcionar com teclado e leitor de tela.
- Ser o mais "server-safe" possível; `"use client"` apenas quando houver estado, efeito ou evento.
- Não conter chamadas de API, regra de negócio, texto de produto hardcoded ou `alert`.

Convenções:

- Arquivo em `kebab-case.tsx`; export em `PascalCase`.
- Props tipadas; sem `any`.
- `children` quando o conteúdo for composicional.
- Ao usar shadcn, preserve o padrão gerado e adapte via tokens; não reescreva o primitivo sem necessidade.

## 5. Componentes atuais

| Componente                                           | Estado                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Button`                                             | Variantes `default`, `secondary`, `outline`, `ghost` e `destructive`; tamanhos `default` (44px), `sm`, `lg` (48px) e `icon` (44×44). `type="button"` por padrão, `asChild`, sombra de arcade que afunda no `active`, foco com anel, `touch-manipulation`, sem transição de cor |
| `Input`                                              | Campo de 44px, borda de 2px, sombra interna, foco visível; `aria-invalid` troca a borda para `destructive` e mais grossa (o erro em texto fica no `Field`)                                                                                                                     |
| `Label`                                              | `<label>` visível em 16px e negrito; sempre com `htmlFor`                                                                                                                                                                                                                      |
| `Field`                                              | Junta `Label`, controle (render prop), texto de erro com cartão vermelho e a ligação `htmlFor`/`id`, `aria-invalid` e `aria-describedby` (o `id` do erro é `${id}-error`); `errorAction` recebe um link que resolve o erro                                                     |
| `PasswordInput`                                      | `Input` de senha com botão de mostrar/ocultar (`aria-pressed`, `aria-controls`, nome "Show password" / "Hide password", `visibilityLabel` para nomear cada campo), 44px, ícones pixel e sem o botão nativo do Edge                                                             |
| `Card`                                               | `Card`, `CardHeader`, `CardTitle` (`as` `h1`/`h2`/`h3`, fonte display, `text-balance`), `CardDescription`, `CardContent` e `CardFooter`; estilo ingresso (borda de 2px, sombra deslocada, linha tracejada)                                                                     |
| `Alert`                                              | Variantes `error` e `warning` (`role="alert"`), `success` e `info` (`role="status"`); cada uma com ícone pixel (cartão vermelho, cartão amarelo, bola na rede, apito) e a mensagem em texto                                                                                    |
| `Spinner`                                            | Bola pixel que gira em passos (`steps(8)`), decorativa (`aria-hidden`), estática com `prefers-reduced-motion`; quem usa anuncia o estado (`role="status"` ou `aria-busy`)                                                                                                      |
| `ThemeToggle`                                        | Botão de alternância "Dark theme" (`aria-pressed`), ícone sol/lua, grava `data-theme` e `localStorage` sem lançar erro; `"use client"`                                                                                                                                         |
| Ícones (`@repo/ui/icons`)                            | Conjunto pixel desenhado em grade de caracteres: `EyeIcon`, `EyeOffIcon`, `SunIcon`, `MoonIcon`, `RedCardIcon`, `YellowCardIcon`, `GoalIcon`, `WhistleIcon`, `BallIcon`; `crispEdges`, decorativos. Não misture outra biblioteca de ícones                                     |
| `FieldBackdrop`, `PixelFormation` (`@repo/ui/pitch`) | Campo visto de cima (listras, linhas, círculo central e a bola, com um único chute de 280ms) e formação 4-3-3; decorativos (`aria-hidden`), só cores da marca                                                                                                                  |
| `RondoMark`, `RondoWordmark`                         | Logos compacto e estendido (DESIGN.md §11), SVG com `crispEdges`; `tone` `auto` (padrão, segue o tema), `light` ou `dark` (fixos); sem `title` ficam ocultos para tecnologia assistiva, com `title="Rondo"` são uma imagem nomeada; aceitam `className`                        |

Os stubs herdados do template (`Card`, `Code` e o `Button` com `alert`) foram removidos e o `Card` atual é o da spec `0018`. Novos primitivos entram pela receita da seção 6 e têm teste em `apps/app/src/ui/` (o `@repo/ui` não tem runner próprio).

## 6. Receita para adicionar um componente

1. Confirme que não existe primitivo equivalente em `packages/ui`.
2. Defina o contrato: propósito, props, variantes, estados e acessibilidade.
3. Implemente com tokens semânticos e Tailwind (após instalação).
4. Adicione exemplo de uso e, se houver lógica, teste.
5. Verifique teclado, foco, contraste e responsividade.
6. Atualize este documento se o contrato ou o local mudar.

## 7. Do / Don't

| Faça                                     | Não faça                                           |
| ---------------------------------------- | -------------------------------------------------- |
| Compor primitivos para criar uma feature | Copiar o código do primitivo e alterar uma cor     |
| Usar tokens semânticos                   | Escrever `#FB6107` no componente                   |
| Manter um único `Button`                 | Criar `PrimaryButton`, `OrangeButton`, `BigButton` |
| Passar `className` para ajustes locais   | Criar props para cada espaçamento                  |
| Testar estados e teclado                 | Validar apenas o caminho feliz no mouse            |

## 8. Lacunas para implementar

- [x] Instalar TailwindCSS e configurar o tema.
- [x] Configurar shadcn/ui em `packages/ui` (`components.json`).
- [x] Definir tokens semânticos em `packages/ui/src/tokens.css`; o `apps/docs` consome o mesmo arquivo (sem hex duplicado).
- [x] Substituir os stubs e remover os links de template.
- [x] Separar os tokens primitivos dos semânticos.
- [x] Decidir dark mode e registrar ADR (`0018`).
- [x] Escolher e carregar fonte display (Press Start 2P, ADR `0019`).
- [x] Revisar contraste real dos pares de cor (`DESIGN.md` §2.5, testado).
- [x] Adicionar verificação de acessibilidade no QA (`e2e/a11y.spec.ts` com `axe`).
- [x] `lang="en-US"` e `<title>` corretos em `apps/app/index.html` e `apps/docs/app/layout.tsx`.
- [ ] Pré-carregar as fontes (`preload`) e definir `theme-color` sem hex fora dos primitivos.
