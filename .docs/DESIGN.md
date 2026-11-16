# Design

> **Público:** qualquer pessoa que crie, altere ou revise UI.
> **Obrigatório** para tarefas de interface. Complementa `DESIGN_SYSTEM.md`.
> **Estado:** identidade "Matchday" aplicada em todas as telas existentes, em tema claro e escuro (spec `0018`, ver §10). Decisões: ADR `0018` (dark mode) e ADR `0019` (fonte display).

## 1. Direção

Interface **retro, inspirada em arte 8-bit, futebol e Brasil**. Deve parecer um produto com identidade própria — não um template de SaaS.

Princípios, em ordem de prioridade:

1. **Legibilidade** vence nostalgia. Pixel art é identidade, não desculpa para texto ruim.
2. **Poucas cores, usadas com intenção.** A paleta é marcante; o fundo neutro evita poluição.
3. **Formas duras e contrastes claros.** Bordas visíveis, cantos quase retos, sombras discretas.
4. **Movimento contido.** Animações curtas e mecânicas, nunca decorativas em excesso.
5. **Acessível por padrão.** Contraste, foco, teclado e leitor de tela não são opcionais.

## 2. Paleta

### 2.1 Cores principais

| Token                    | Hex       | RGB          | Papel sugerido                            |
| ------------------------ | --------- | ------------ | ----------------------------------------- |
| `--color-blaze-orange`   | `#FB6107` | 251, 97, 7   | Ação primária, destaque, energia          |
| `--color-golden-glow`    | `#F3DE2C` | 243, 222, 44 | Realce, badges, detalhes                  |
| `--color-lime-moss`      | `#7CB518` | 124, 181, 24 | Estados positivos, séries de dados        |
| `--color-forest-moss`    | `#5C8001` | 92, 128, 1   | Apoio, bordas e texto sobre fundos claros |
| `--color-sunflower-gold` | `#FBB02D` | 251, 176, 45 | Acento secundário, hover                  |

### 2.2 Neutros (proposta)

| Token           | Hex       | Papel                                  |
| --------------- | --------- | -------------------------------------- |
| `--color-ink`   | `#0A0A0A` | Texto principal e fundo escuro         |
| `--color-paper` | `#FFFDF5` | Fundo claro (branco quente, não cinza) |
| `--color-muted` | `#6B6B6B` | Texto secundário sobre fundo claro     |

Não use cinzas frios genéricos como base. Se precisar de mais tons, derive de `ink`/`paper` com opacidade.

Para os temas existem primitivos derivados, todos em `packages/ui/src/tokens.css` (hex só ali): `paper-shade` `#F1EDE1` (superfície suave do claro), `ink-muted` `#6B6B6B`, `night` `#0F0F0C` (fundo escuro), `night-raised` `#1B1B16` (cartão escuro), `night-hover` `#2A2A22`, `chalk-muted` `#B5B1A0` (texto secundário escuro), `card-red` `#B91C1C` e `card-red-light` `#F87171` (erro nos dois temas).

### 2.4 Temas (claro e escuro)

- O tema vive em `<html data-theme="light|dark">`, definido antes da primeira pintura: escolha guardada (`localStorage["rondo-theme"]`, por app) ou `prefers-color-scheme`. O `ThemeToggle` alterna os dois estados e fica no cabeçalho de `/app`, no `AuthLayout` e no docs. Ver ADR `0018`.
- No escuro: fundo `night`, cartão `night-raised`, texto e bordas `paper`, foco `golden-glow`, sombra deslocada `forest-moss`. A ação primária continua `blaze-orange` com texto `ink`. O logo usa a versão do tema (`tone="auto"`).
- Todo componente usa só tokens semânticos; uma cor nova precisa de par claro e escuro e de uma linha na tabela abaixo (o teste `apps/app/src/ui/theme-contrast.test.ts` falha se um par cair abaixo do mínimo).

### 2.5 Contraste real dos pares semânticos

Calculado a partir de `tokens.css` pelo teste citado (WCAG 2.2: texto 4,5:1; UI e foco 3:1):

| Par (texto ou UI sobre fundo)                           | Claro         | Escuro        |
| ------------------------------------------------------- | ------------- | ------------- |
| `foreground` sobre `background`                         | 19,44         | 18,85         |
| `card-foreground` sobre `card`                          | 19,44         | 16,97         |
| `muted-foreground` sobre `background`                   | 5,23          | 8,92          |
| `muted-foreground` sobre `card`                         | 5,23          | 8,03          |
| `foreground` sobre `muted` (hover do botão outline)     | 16,91         | 14,19         |
| `primary-foreground` sobre `primary` (rótulo do botão)  | 6,42          | 6,42          |
| `accent-foreground` sobre `accent` (hover)              | 10,70         | 10,70         |
| `secondary-foreground` sobre `secondary`                | 14,42         | 14,42         |
| `destructive` (texto de erro) sobre `background`        | 6,35          | 6,94          |
| `destructive` (texto de erro) sobre `card`              | 6,35          | 6,25          |
| `destructive-foreground` sobre `destructive`            | 6,35          | 7,16          |
| `success-foreground` sobre `success`                    | 7,99          | 7,99          |
| `warning-foreground` sobre `warning`                    | 14,42         | 14,42         |
| `info-foreground` sobre `info`                          | 16,91         | 16,97         |
| `border` / `input` sobre `background` e `card` (UI)     | 19,44 / 19,44 | 18,85 / 16,97 |
| `ring` (foco) sobre `background` e `card` (UI)          | 4,54          | 13,98 / 12,59 |
| `primary` (botão) sobre `background` e `card` (UI)      | 3,03          | 6,23 / 5,61   |
| `destructive` (borda de campo e de alerta) sobre `card` | 6,35          | 6,25          |

Os pares de destaque da §2.3 seguem valendo: o laranja e o amarelo nunca levam texto que não seja `ink`. O verde do campo, o laranja e o amarelo das ilustrações são decorativos e ficam fora da conta de contraste.

### 2.3 Regras de contraste

Contrastes aproximados contra branco (`#FFFFFF`):

| Cor       | Contraste | Uso permitido                                                  |
| --------- | --------- | -------------------------------------------------------------- |
| `#FB6107` | ~3,1:1    | Texto grande (>= 24px), ícones e bordas; **não** texto normal  |
| `#F3DE2C` | ~1,4:1    | **Nunca** texto sobre branco; usar como fundo com texto escuro |
| `#7CB518` | ~2,5:1    | Ícones/gráficos; **não** texto normal                          |
| `#5C8001` | ~4,6:1    | Texto normal sobre fundo claro (passa AA)                      |
| `#FBB02D` | ~1,9:1    | Fundo de destaque com texto escuro; **não** texto normal       |

Regras práticas:

- Texto sobre qualquer cor de destaque deve ser `--color-ink`.
- Cor nunca é o único indicador de estado; combine com ícone, texto ou padrão.
- Ao criar um par de cores, valide o contraste real (DevTools, axe ou Lighthouse), não confie na percepção.

## 3. Tipografia

| Uso                         | Estilo                                      | Regra                                                  |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| Títulos e números de placar | Fonte display com personalidade pixel/8-bit | Só em títulos curtos e números; nunca em parágrafos    |
| Corpo e interface           | Sans-serif legível                          | Tamanho mínimo 16px no corpo; 14px apenas em metadados |
| Dados tabulares             | Mono-espaçada                               | Números alinhados, ideal para tabelas e métricas       |

Fontes adotadas (ADR `0019`): **Press Start 2P** (display), **Geist** (corpo) e **Geist Mono** (dados), auto-hospedadas em `packages/ui/assets/fonts/` (`.woff2` latino, licença OFL) e declaradas em `packages/ui/src/fonts.css` com `font-display: swap`; sem CDN. Utilitários: `font-display`, `font-sans`, `font-mono`. Escala da fonte display: 16px (títulos de card), 20–24px (títulos de tela), 32–60px (saudação e placar). Títulos longos quebram com `text-wrap: balance`. Nunca use a fonte pixel abaixo de 16px, em parágrafo ou em mensagem de erro.

## 4. Motivos visuais

Use com moderação:

- Grade de pixels sutil, bordas de 2–4px, cantos com raio 0–4px.
- Ícones e ilustrações em pixel art, com contorno consistente.
- Referências de futebol: números de camisa, placar, campo, faixas; referências de Brasil: verde/amarelo, sem cair no clichê.
- Sombras duras e deslocadas (efeito "botão de arcade"), não sombras difusas.
- **Matchday:** campo em pixel (`FieldBackdrop`) nas telas de auth e no docs, formação 4-3-3 (`PixelFormation`) na home, placar "404" no 404. É uma ousadia por tela; o resto fica quieto.
- **Cartões de aviso** (`Alert`): cartão vermelho para erro, cartão amarelo para aviso, bola na rede para sucesso e apito para informação. O ícone nunca é o único sinal: a mensagem sempre está em texto.
- **Ícones:** só o conjunto pixel de `@repo/ui/icons` (grade própria, `crispEdges`, decorativos com `aria-hidden`).

Evite:

- Gradientes suaves, glassmorphism, blur decorativo e brilho neon genérico.
- Cantos muito arredondados (>= 16px) como padrão.
- Excesso de cores na mesma tela; escolha uma cor dominante e uma de apoio.
- Pixel art em tamanhos que quebrem a grade ou fiquem ilegíveis.

## 5. Layout e espaçamento

- **Mobile-first.** Valide em 375px, 768px e 1280px no mínimo.
- Base de espaçamento em múltiplos de 4px.
- Conteúdo com largura máxima confortável para leitura; não estique texto em telas largas.
- Áreas de toque com no mínimo 44×44px.
- Tabelas e gráficos devem ter fallback para telas estreitas (scroll horizontal controlado ou visão resumida).

## 6. Movimento

- Duração curta: 120–200ms para feedback; até 300ms para transições de painel.
- Prefira `steps()` ou easing seco para reforçar o efeito 8-bit.
- Respeite `prefers-reduced-motion: reduce` e desative animações não essenciais.
- Não anime conteúdo que muda de layout repetidamente; nada de "piscando" constante.

## 7. Acessibilidade (obrigatório)

- Meta: **WCAG 2.2 AA**.
- Foco visível com contraste mínimo de 3:1; nunca remova `outline` sem substituto.
- Navegação completa por teclado; ordem de tabulação lógica.
- HTML semântico (`button`, `a`, `label`, `nav`, `main`, headings em ordem).
- Todo input tem label associado; erros são anunciados e descritos em texto.
- Imagens com `alt` significativo; decorativas com `alt=""`.
- Não dependa de cor, posição ou forma isolada para comunicar estado.
- `lang="en-US"` em `apps/app` e `apps/docs` (decisão de 2026-11-09).

## 8. Conteúdo e tom

- Idioma: **en-US** para interface, mensagens da API e e-mails; esta documentação segue em pt-BR.
- Tom direto, técnico e futebolístico; evite jargão de marketing.
- Datas e números no padrão `en-US` na interface (ISO 8601 UTC nos contratos de API).
- Não entregue `lorem ipsum`, placeholder ou texto de template em tela final.
- Microcopy de erro deve dizer o que aconteceu e o que fazer em seguida.

## 9. Do / Don't

| Faça                                       | Não faça                                                |
| ------------------------------------------ | ------------------------------------------------------- |
| Usar uma cor de destaque por ação primária | Colorir todos os botões com cores diferentes            |
| Texto escuro sobre amarelo/laranja         | Texto branco sobre amarelo/laranja                      |
| Bordas nítidas e formas consistentes       | Misturar estilos flat, glass e neumórfico               |
| Ícones pixel com grade consistente         | Misturar ícones de bibliotecas diferentes               |
| Validar contraste e teclado                | Confiar apenas no visual                                |
| Exibir a marca Rondo em toda tela (§11.2)  | Criar uma tela, ou um estado de tela cheia, sem a marca |

## 10. Estado da implementação

| Item                             | Estado                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Paleta aplicada em tokens        | Sim: primitivos e semânticos (claro e escuro) em `packages/ui/src/tokens.css`; `apps/docs` consome o mesmo arquivo                                                       |
| Fonte display                    | Sim: Press Start 2P, Geist e Geist Mono auto-hospedadas (ADR `0019`)                                                                                                     |
| Dark mode                        | Sim: `data-theme` no `<html>`, script pré-pintura, `ThemeToggle` (ADR `0018`)                                                                                            |
| Marca (logos Rondo)              | Sim: `RondoMark` e `RondoWordmark` (`tone="auto"` segue o tema); wordmark no `AuthLayout`, no cabeçalho de `/app` e no docs; marca compacta no 404 e nas telas de sessão |
| Componentes no estilo 8-bit      | Sim: `Button`, `Input`, `Label`, `PasswordInput`, `Card`, `Alert`, `Field`, `Spinner`, `ThemeToggle`, ícones e campo/formação em pixel (`DESIGN_SYSTEM.md` §5)           |
| `lang="en-US"`                   | Sim (`apps/app` e `apps/docs`)                                                                                                                                           |
| Revisão de contraste             | Sim: §2.5, testada nos dois temas                                                                                                                                        |
| Testes de teclado/leitor de tela | Teclado e `axe` (E2E `e2e/a11y.spec.ts`, 12 telas × 2 temas); leitor de tela ainda não verificado                                                                        |
| Dívida                           | `<meta name="theme-color">` não definida (exigiria hex fora dos primitivos); fontes sem `preload`                                                                        |

Os tokens são definidos em `packages/ui/src/tokens.css` e consumidos pelos componentes. Não espalhe hex pelo código.

## 11. Marca

O produto se chama **Rondo** (antes "Analytics Personas"). O nome vem do rondó, o treino em que os jogadores trocam a bola em roda sem perdê-la: a metáfora de experts e fontes passando o conhecimento do clube.

**Tagline:** "Club knowledge, in play." (en-US, como toda a interface).

### 11.1 Logos

| Versão    | Arquivo                                                   | Uso                                                                   |
| --------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| Compacta  | `rondo-mark.svg`, `rondo-mark-dark.svg` (28 × 28)         | Avatar, favicon, ícone de app, espaços quadrados ou menores que 140px |
| Estendida | `rondo-wordmark.svg`, `rondo-wordmark-dark.svg` (70 × 14) | Cabeçalho, e-mails, site, documentos                                  |

Todos os arquivos ficam em `packages/ui/assets/brand/`, são SVG de retângulos sem fonte embutida (nada depende de carregar a fonte display) e usam `shape-rendering="crispEdges"`.

- **Compacta:** bola pixel no centro e quatro quadrados em roda: `blaze-orange` (cima), `golden-glow` (direita), `lime-moss` (baixo) e `forest-moss` (esquerda). Quatro quadrados pequenos em `sunflower-gold` marcam o passe nas diagonais. Em fundo escuro, o quadrado da esquerda vira `sunflower-gold`, porque `forest-moss` some sobre `ink`.
- **Estendida:** "ROND" em pixel e uma bola pixel no lugar do último "O". A bola usa uma grade mais fina que as letras (1 unidade contra 2), como na versão aprovada.

### 11.2 Toda tela leva a marca

**Regra:** toda tela do produto exibe o logo Rondo. Isso vale para páginas e também para telas cheias de estado: carregando, erro, vazio, 404 e qualquer outra que ocupe a janela. Uma tela nova sem a marca não passa na revisão.

| Situação                                                                                      | Logo                                                                                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Tela com cabeçalho ou layout compartilhado (`/auth/*`, o shell de `/app` com sessão e o docs) | Estendida no cabeçalho, com `title="Rondo"` (é a única vez que o nome aparece em texto de imagem) |
| Tela cheia sem cabeçalho (carregando, erro de sessão, 404)                                    | Compacta, decorativa, acima do título ou da mensagem, em 56px (`size-14`)                         |

- **No layout, não na página.** Quando as telas dividem um layout, a marca vai no layout (`AuthLayout`, `AppLayout` ou o shell futuro), uma vez, e não repetida em cada página. Telas fora de um layout incluem o componente elas mesmas.
- **Uma marca por tela.** Se a tela já tem o logo estendido no cabeçalho, não repita o compacto no corpo.
- **Componentes, não arquivos.** No app, use `RondoMark` e `RondoWordmark` de `@repo/ui/brand`; os SVGs de `packages/ui/assets/brand/` são para fora do app (docs, e-mails, favicon).
- **Prova.** Toda tela nova ganha uma asserção da marca no teste da tela (veja `apps/app/src/brand.test.tsx`).
- **Fora desta regra:** modais, popovers, toasts e componentes dentro de uma tela, que não repetem a marca. E-mails seguem a regra de e-mail, ainda a definir.

### 11.3 Regras de uso

- **Fundos:** versão clara sobre `paper` ou branco; versão escura sobre `ink`. Não coloque o logo sobre cor de destaque nem sobre imagem.
- **Tamanho mínimo:** compacta com 16px de lado (múltiplos de 28 ficam nítidos: 28, 56, 84, 112); estendida com 70px de largura (múltiplos de 70).
- **Respiro:** margem livre de uma "casa" da bola (1/14 da altura do logo) para cada lado, no mínimo 4px.
- **Não faça:** esticar, girar, recolorir, trocar a ordem das cores, adicionar sombra ou contorno, ou redesenhar a bola com gradiente.
- **Acessibilidade:** o SVG tem `<title>Rondo</title>`. Quando o logo é decorativo ao lado do nome em texto, use `alt=""`; quando é o único nome visível, use `alt="Rondo"`.
- **Tagline:** em texto normal (sans do corpo), nunca na fonte pixel abaixo de 16px, e em `ink` sobre `paper` ou `paper` sobre `ink`.

### 11.4 Onde a marca aparece

| Lugar                                                              | Logo                                    |
| ------------------------------------------------------------------ | --------------------------------------- |
| Telas `/auth/*` (cabeçalho)                                        | Estendida, com `title="Rondo"`          |
| Home `/app` (cabeçalho do shell)                                   | Estendida, com `title="Rondo"`          |
| Página 404, carregando e erro de sessão                            | Compacta, decorativa                    |
| Favicon de `apps/app` e `apps/docs`; página inicial de `apps/docs` | Compacta (favicon) e estendida (página) |

Os componentes de `@repo/ui/brand` são a fonte para as telas do app. O `apps/docs` também os usa desde a spec `0018`. Os favicons são cópias dos SVGs (`apps/docs/app/icon.svg`, `apps/app/public/favicon.svg`) e `apps/docs/public/brand/rondo-wordmark.svg` ficou sem uso na página; um teste em `apps/app/src/brand.test.tsx` falha se as cópias ou os componentes divergirem de `packages/ui/assets/brand/`. As cores da marca são tokens fixos em `tokens.css` (`--color-blaze-orange` etc.).

### 11.5 Fora do escopo desta versão

O nome exibido nos e-mails, nos logs e na telemetria é "Rondo". Os e-mails ainda não usam a identidade visual das telas (regra de e-mail a definir).
