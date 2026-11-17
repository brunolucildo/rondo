# 0021 — Avatares 8-bit dos experts com gpt-image-2

> Spec executável. Preencha todas as seções; `TODO` é lacuna, não requisito.
> Use `create-spec` para criar, `refine-spec` para auditar e `implement-me` para executar.

- **Status:** em implementação (pendente: geração real e aprovação dos 7 PNGs; ver plano)
- **Slug:** 0021-experts-avatars-pixel-art
- **Data:** 2026-11-17
- **Atualizado em:** 2026-11-17
- **Owner:** Produto/Design (aprovação da arte); Time de engenharia (execução)
- **Relacionados:** mapa `.plans/experts-breakdown.md`; `.docs/DESIGN.md` e `.docs/DESIGN_SYSTEM.md` (identidade 8-bit); spec `0018` (redesign retro 8-bit); ADR `0019` (fontes auto-hospedadas). **Depende de:** 0019 (catálogo, nomes dos personagens e slot de avatar com fallback). **Destrava:** nenhuma spec (fecha a identidade visual da home).

## 1. Escopo

### Dentro do escopo

- **Um avatar pixel art 8-bit por expert** (7 no total), de um **personagem fictício** definido na 0019, gerados **uma única vez** com o modelo `gpt-image-2` da OpenAI e **commitados como assets estáticos** do app.
- **Script manual e reprodutível** que chama a Image API, normaliza o resultado (reduz para a grade de pixel, limita a paleta, salva PNG quadrado) e grava os arquivos; os **prompts ficam versionados** no repositório.
- **Ficha de cada personagem** (aparência, adereços, cores) em `DESIGN.md`, para a arte ser refeita ou ampliada de forma consistente.
- **Uso na interface:** o slot de avatar da 0019 passa a mostrar o PNG do expert (no estado vazio, no dropdown e ao lado das respostas), mantendo o fallback quando o arquivo não carrega.
- Revisão humana obrigatória e checklist de aprovação; atualização de `DESIGN.md`, `DEVELOPMENT.md`/`AGENTS.md` (novo comando) e `QA.md`.

### Fora do escopo

- Geração de imagem ou vídeo **em tempo de execução** (nas respostas do chat, por demanda do usuário): backlog.
- Geração de vídeo com `gemini-omni-flash`: backlog (o modelo gera e edita vídeo e não é usado nesta fase).
- Animação, sprites com vários quadros e variações de humor dos avatares: backlog.
- Logo Rondo, ilustrações de campo e ícones (spec `0018` segue válida).
- Avatar enviado pelo usuário ou foto de pessoa real.
- Compartilhar o script com o app em produção: o script é ferramenta de desenvolvimento e não roda no servidor.

## 2. Contexto

**Estado atual.** Após a 0019, o expert já tem nome, função e personagem fictício, mas o avatar é um fallback genérico em pixel art vetorial. A identidade do produto é arcade/8-bit com futebol (`0018`), e o pedido é que cada expert tenha "uma imagem de profile 8bit retro com o seu personagem fictício".

**Por que uma geração única.** Os avatares são **assets**, não conteúdo dinâmico: gerar uma vez custa 7 chamadas, evita dependência do provedor em tempo de execução e permite revisão humana. O `gpt-image-2` é a Image API da OpenAI (`POST /v1/images/generations`, modelo `gpt-image-2`); o custo e a política de conteúdo devem ser conferidos na documentação oficial da OpenAI no momento da execução.

**Personagens.** São fictícios. O Head Coach evoca o estilo de um técnico veterano, sem a imagem de uma pessoa real. Nenhum personagem usa escudo de clube, marca, texto legível ou rosto de alguém real.

## 3. Necessidade de negócio

| Item                     | Descrição                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Usuário/papel afetado    | Pessoa autenticada que escolhe o expert na home.                                                           |
| Decisão ou ação que muda | Reconhece cada função pelo personagem e sente que fala com "alguém", não com um menu.                       |
| Resultado esperado       | 7 avatares 8-bit coerentes entre si e com a identidade do produto, usados em todo lugar onde o expert aparece. |
| Métrica de sucesso       | Aprovação do Produto/Design na revisão; 0 imagens quebradas; peso total dos avatares abaixo de 150 KB.     |

## 4. Requisitos

| ID  | Requisito                                                                                                                                                                                                                                                                                         | Prioridade | Critério de aceite                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Existe um PNG por expert (`head-coach`, `performance-analyst`, `sports-lawyer`, `physiologist`, `sports-physician`, `physiotherapist`, `football-manager`), quadrado, com a **grade de pixel visível** (reduzido por vizinho mais próximo), paleta limitada e fundo compatível com tema claro e escuro. | Must       | Given os 7 arquivos nos assets, Then cada um é PNG quadrado de 96×96 px a 192×192 px, com no máximo 32 cores e no máximo 20 KB; o conjunto soma menos de 150 KB (verificado por teste que lê os arquivos).                                                              |
| R2  | Script `bun run experts:avatars` (novo comando documentado): lê as fichas e prompts versionados, chama a Image API com `OPENAI_API_KEY`, gera **um expert por vez** (`--expert <id>` ou `--all`), pula os que já têm arquivo (a menos que `--force`) e grava o PNG normalizado. Sem chave ou sem flag, não chama a API. | Must       | Given nenhuma flag, When roda, Then imprime a ajuda e não chama a API. Given `--expert head-coach` e um arquivo existente, Then não regenera sem `--force`. Given a chave ausente, Then sai com código ≠ 0 e mensagem clara, sem tráfego de rede (teste com cliente falso). |
| R3  | Prompts e fichas dos personagens vivem no repositório (um arquivo por expert ou uma tabela versionada), sem texto na imagem, sem escudos, sem marcas e sem pessoa real; o prompt do Head Coach não cita o nome de nenhuma pessoa.                                                                  | Must       | Given os arquivos de prompt, Then nenhum contém nome de pessoa real, de clube ou de marca (teste com lista de termos proibidos) e todos pedem "pixel art, 8-bit, sem texto".                                                                                              |
| R4  | A interface usa o PNG do expert no estado vazio, no dropdown e no cabeçalho de cada resposta; `image-rendering: pixelated`; dimensões fixas (sem salto de layout); `alt=""` quando o nome do expert está ao lado e `alt` descritivo quando a imagem estiver sozinha; fallback quando o arquivo falhar. | Must       | Given um expert selecionado, Then o avatar aparece nítido (sem suavização) nos três lugares, sem layout shift. Given o arquivo indisponível, Then o fallback da 0019 aparece e a conversa funciona. Axe sem violações de imagem.                                          |
| R5  | O app resolve o avatar de cada expert **pelo `id`**, importando os 7 PNGs como assets do Vite (nome com hash gerado no build); `GET /api/v1/experts` **não** devolve avatar, porque a API não conhece os nomes do build. Expert sem arquivo mapeado usa o fallback da 0019.                                                                                                                       | Must       | Given o mapa de avatares do app, Then cada um dos 7 `id` do catálogo tem um PNG mapeado (teste compara os ids de `GET /api/v1/experts` com o mapa) e a resposta da API não traz o campo `avatar`.                                                                                                                                            |
| R6  | Falhas do script não derrubam o lote: erro da API, bloqueio por política de conteúdo ou timeout (60 s por imagem, 1 nova tentativa) são registrados por expert; o script continua com os demais e termina com código ≠ 0 se algum falhou. Nenhum arquivo parcial é gravado.                       | Must       | Given o cliente falso que bloqueia `physiologist`, When roda `--all`, Then gera os outros seis, lista o motivo da falha do `physiologist` e sai com código ≠ 0, sem arquivo para ele.                                                                                    |
| R7  | Revisão humana e documentação: `DESIGN.md` ganha a seção "Personagens dos experts" (ficha, paleta, adereços) e o checklist de aprovação; `QA.md` e `AGENTS.md` documentam `experts:avatars`; os avatares só entram na `main` depois da aprovação do Produto/Design.                              | Must       | Given o PR, Then inclui as fichas, o checklist marcado e a captura da home com os 7 avatares em tema claro e escuro; o Produto/Design aprovou.                                                                                                                           |
| R8  | A chamada à OpenAI usa só `gpt-image-2`; o modelo e o tamanho solicitado são configuráveis por variável (`OPENAI_IMAGE_MODEL`, padrão `gpt-image-2`) e o script registra modelo, data e prompt usados em um arquivo de manifesto ao lado das imagens.                                              | Should     | Given a execução, Then o manifesto lista, por expert, modelo, data e hash do prompt.                                                                                                                                                                                     |

## 5. Fluxos e estados

- **Caminho feliz:** o desenvolvedor define a chave, roda `bun run experts:avatars -- --expert head-coach`, revisa o PNG, ajusta o prompt se preciso, repete para os demais, abre o PR com o checklist e a captura; depois da aprovação, os avatares aparecem na home.
- **Vazio:** sem arquivo para um expert, a interface mostra o fallback da 0019.
- **Carregando:** a imagem tem dimensões fixas; enquanto carrega, o espaço mostra o fallback (sem salto de layout).
- **Erro:** chave ausente → mensagem e saída ≠ 0; bloqueio de conteúdo, timeout ou falha da API → erro por expert, lote segue; imagem corrompida no navegador → fallback.
- **Sucesso parcial:** alguns experts com PNG e outros com fallback é um estado válido e funcional da interface.
- **Cancelamento/retry:** interromper o script (Ctrl+C) não deixa arquivo parcial; rodar de novo gera só os que faltam; `--force` regenera um expert específico.

## 6. Acceptance Criteria

- [ ] Given os 7 PNGs, Then cada um é quadrado (96 a 192 px), com no máximo 32 cores e 20 KB, e o conjunto soma menos de 150 KB.
- [ ] Given `bun run experts:avatars` sem flag ou sem chave, Then não há chamada de rede.
- [ ] Given um arquivo existente, Then o script não o regenera sem `--force`.
- [ ] Given o bloqueio de um expert, Then os demais são gerados e o código de saída é ≠ 0, sem arquivo parcial.
- [ ] Given os arquivos de prompt, Then não há nome de pessoa real, clube ou marca, e todos pedem "pixel art, 8-bit, sem texto".
- [ ] Given a home, Then o avatar aparece sem suavização no estado vazio, no dropdown e nas respostas, sem salto de layout.
- [ ] Given o arquivo indisponível, Then o fallback aparece.
- [ ] Given os 7 `id` do catálogo, Then cada um tem um PNG no mapa de avatares do app e `GET /api/v1/experts` não traz `avatar`.
- [ ] Given o PR, Then traz as fichas em `DESIGN.md`, o checklist e a captura aprovada pelo Produto/Design.
- [ ] Given `bun run lint`, `check-types` e `test`, Then passam; nenhum teste automatizado chama a OpenAI.

## 7. O que fazer

1. Definir, com o Produto/Design, a ficha de cada personagem (aparência, adereços, paleta) a partir dos nomes da 0019 e registrar em `DESIGN.md`.
2. Escrever os prompts versionados e a lista de termos proibidos.
3. Criar `scripts/experts-avatars.ts` (Bun) e o comando `experts:avatars` no `package.json` da raiz: cliente da Image API com timeout e uma nova tentativa, normalização (vizinho mais próximo, paleta limitada, PNG quadrado), escrita atômica e manifesto; qualquer biblioteca de imagem entra como devDependency justificada no relatório (`DEVELOPMENT.md` §10).
4. Gerar os 7 avatares, revisar um a um e ajustar prompts até a aprovação.
5. Adicionar os assets ao app (o Vite gera o nome com hash) e ligar o slot de avatar da 0019 por um mapa `id` → imagem no app (a API não devolve avatar).
6. Escrever os testes: arquivos (formato, tamanho, cores), script com cliente falso (sem flag, sem chave, `--force`, bloqueio), prompts (termos proibidos) e componente (fallback, `alt`).
7. Atualizar `DESIGN.md`, `QA.md` e `AGENTS.md` (novo comando e custo estimado de 7 chamadas).

## 8. O que não fazer

- Não chamar a Image API em testes, em CI nem no servidor em tempo de execução.
- Não commitar a chave da OpenAI nem imagens brutas em alta resolução.
- Não usar rosto, nome ou citação de pessoa real, escudo de clube, marca ou texto legível na imagem.
- Não gerar os 7 de uma vez sem revisão: o script exige a flag explícita e a revisão acontece por expert.
- Não suavizar a imagem no navegador; não usar `object-fit` que altere a proporção.
- Não adicionar geração de vídeo, `gemini-omni-flash` ou geração no chat (backlog).

## 9. Riscos e dependências

| Tipo        | Descrição                                                                                                    | Mitigação                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Dependência | 0019 (ids, nomes dos personagens, slot de avatar e fallback).                                                | Implementar depois dela.                                                                                          |
| Dependência | OpenAI Image API (`gpt-image-2`), disponível desde abril de 2026 segundo a documentação da OpenAI.           | Conferir modelo, custo e política na documentação oficial na execução; `OPENAI_IMAGE_MODEL` permite trocar.       |
| Risco       | A saída não parece "8-bit" de verdade (gradiente, suavização, estilos misturados).                            | Normalização no script (grade e paleta) e revisão humana por expert.                                              |
| Risco       | Semelhança com uma pessoa real (Head Coach) ou com marcas.                                                    | Prompt sem nomes, checklist de revisão, lista de termos proibidos e aprovação do Produto/Design.                  |
| Risco       | Custo ou limite de uso da API durante a iteração de prompts.                                                  | Geração por expert, sem `--all` por padrão; estimativa de custo documentada em `AGENTS.md`.                       |
| Risco       | Bloqueio de conteúdo pela política da OpenAI em algum personagem.                                             | Falha isolada por expert (R6); ajustar o prompt; o fallback continua válido.                                      |

## 10. Resultado

Como validar que a spec foi atendida:

- **Comando/verificação:** `bun run lint`, `bun run check-types`, `bun run test`; `bun run dev` e abrir `/app` em tema claro e escuro; `bun run experts:avatars` (sem flag) para ver a ajuda.
- **Evidência esperada:** testes verdes; captura da home com os 7 avatares nos dois temas; PR com as fichas, o checklist e a aprovação do Produto/Design; manifesto com modelo e data.
- **Comportamento observável:** cada expert aparece com o seu personagem pixel art, nítido, no estado vazio, no dropdown e nas respostas; se um arquivo falhar, o fallback assume.

## 11. Perguntas abertas e premissas

| Pergunta/Premissa                                                                                                                                  | Impacto                                          | Bloqueante? | Quem decide     |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------- | --------------- |
| **Premissa (compartilhada):** `gpt-image-2` serve só para os avatares, uma vez; geração de imagem ou vídeo no chat fica no backlog.                | Escopo do uso de `gpt-image-2` e `gemini-omni-flash`. | Não         | Produto         |
| **Premissa:** PNG de 96×96 a 192×192 px, até 32 cores, até 20 KB cada, servido como asset do app.                                                   | Qualidade e peso.                                | Não         | Design          |
| **Premissa:** os experts têm personagens fictícios e a aprovação final da arte é do Produto/Design.                                                | Calendário do release.                           | Não         | Produto/Design  |
| **Premissa (execução 2026-11-17):** os prompts são em inglês (o modelo responde melhor) e pedem "pixel art, 8-bit, no text", o equivalente de "sem texto" de R3; o tamanho pedido à API é `1024x1024` (`OPENAI_IMAGE_SIZE`) e o arquivo final tem 144 px (grade de 48 px, 3x), com até 16 cores mais a transparência do fundo. | Qualidade e peso. | Não | Eng. |
| **Premissa (execução 2026-11-17):** a ferramenta é o workspace `packages/experts-avatars` (com `lint`, tipos e testes no Turborepo) e `scripts/experts-avatars.ts` só a chama; o "dropdown" é um `<select>` nativo, então o avatar do expert escolhido aparece ao lado do campo. | Estrutura e UI. | Não | Eng. |
| **Premissa (execução 2026-11-17):** sem `OPENAI_API_KEY` na execução orquestrada, os 7 PNGs não foram gerados; a completude é um teste opt-in (`REQUIRE_ALL_AVATARS=1`) a ligar depois da geração e da aprovação. | R1, R5 e R7 ficam pendentes. | Não | Produto/Design |
| Pergunta: os termos de uso da OpenAI para imagens geradas exigem alguma atribuição no produto?                                                     | Texto no produto ou na documentação.             | Não         | Jurídico        |
| **Premissa:** o avatar é resolvido no app pelo `id` do expert; a API não devolve avatar (decisão de 2026-11-17, refinamento da 0019 e da 0021). | Contrato de `GET /experts` (0019 R1) e requisito R5. | Não | Eng. |

## 12. Refinamento

| Data       | O que mudou            | Motivo                                          |
| ---------- | ---------------------- | ----------------------------------------------- |
| 2026-11-17 | Spec criada (rascunho) | Quebra do épico de experts (`breakdown-specs`). |
| 2026-11-17 | R5, critérios de aceite e passo 5 reescritos: o app mapeia `id` → PNG e a API não devolve avatar; passo 3 pede justificar a biblioteca de imagem | Incoerência de arquitetura: os assets são do app Vite (nome com hash) e a API não conhece os nomes; alinhado ao ajuste de R1 da 0019 |
| 2026-11-17 | Premissas de execução: ferramenta em workspace, prompts em inglês, avatar ao lado do seletor, geração real pendente | `implement-me` sem chave da OpenAI |
