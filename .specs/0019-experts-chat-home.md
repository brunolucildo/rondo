# 0019 — Home de chat com experts

> Spec executável. Preencha todas as seções; `TODO` é lacuna, não requisito.
> Use `create-spec` para criar, `refine-spec` para auditar e `implement-me` para executar.

- **Status:** pronta
- **Slug:** 0019-experts-chat-home
- **Data:** 2026-11-17
- **Atualizado em:** 2026-11-17
- **Owner:** Produto (persona, perguntas sugeridas, textos); Time de engenharia (execução)
- **Relacionados:** mapa `.plans/experts-breakdown.md`; `.docs/BUSINESS.md` §4 e §10; `.docs/ARCHITECTURE.md` §4.2, §4.3 e §4.7; ADR `0014` (request handler por endpoint); specs `0005` (sessão), `0008` (sign-out), `0018` (identidade 8-bit). **Depende de:** nenhuma spec pendente. **Destrava:** 0020, 0021, 0023, 0024.

## 1. Escopo

### Dentro do escopo

- **Catálogo fixo de 7 experts**, definido em código (não editável pelo usuário): Head Coach, Performance Analyst, Sports Lawyer, Physiologist, Sports Physician, Physiotherapist e Football Manager. Cada um tem `id` (slug), nome de exibição, função, nome de um **personagem fictício**, descrição curta, perfil de persona (tom, escopo, limites) e lista de **perguntas sugeridas**.
- `GET /api/v1/experts`: devolve o catálogo público (sem o prompt de sistema).
- **Home do grupo `/app`** passa a ser a tela de chat: área de mensagens e **barra fixa no rodapé** com (a) dropdown de expert, (b) textarea de prompt com envio e (c) o cabeçalho existente (wordmark, alternância de tema e **sign-out**) mantido.
- **Estado vazio do expert:** avatar, nome, função, descrição e as perguntas sugeridas; clicar em uma sugestão **envia-a imediatamente** como mensagem do usuário.
- **Chat em formato de conversa:** balões do usuário e do expert, resposta em **streaming** (SSE), parar geração, tentar de novo.
- `POST /api/v1/experts/:expertId/messages`: executa um grafo **LangGraph.js** com **LangChain.js** e `gpt-4o-mini` com a persona do expert. O histórico enviado ao modelo vem do cliente (conversa só na memória da página).
- **Avatar com fallback:** o slot de avatar mostra um fallback em pixel art (SVG/CSS) até a spec 0021 entregar as imagens. O app escolhe o avatar pelo `id` do expert (a API não devolve avatar); sem imagem para o `id`, mostra o fallback.
- **Aviso fixo** sob o campo de texto nos experts de saúde e jurídico (informativo, não substitui profissional).
- Instalação e configuração de `langchain`, `@langchain/openai` e `@langchain/langgraph` em `apps/api`; variáveis de ambiente do LLM; atualização de `.env.example`, `ARCHITECTURE.md`, `BUSINESS.md`, `QA.md` e **ADR** (LangGraph como biblioteca dentro da API).

### Fora do escopo

- Persistência e recarga da conversa, "limpar conversa": **0020**.
- Imagens finais dos avatares geradas com `gpt-image-2`: **0021**.
- Weaviate, embeddings e qualquer uso de arquivos: **0022** e **0023**.
- Botão flutuante de conexões, upload e dedup: **0023**. Citações e respostas ancoradas em fontes: **0024**. Listar e excluir conexões: **0025**.
- Conexões de imagem, URL, áudio e vídeo, traces ricos do LangGraph e LangSmith: fase 2 do mapa (backlog).
- Geração de imagem ou vídeo nas respostas do chat (`gpt-image-2` e `gemini-omni-flash` como ferramenta do expert): backlog.
- LangGraph Platform/Deployment, Studio e avaliação offline: backlog (exigem licença ou serviço em nuvem; ver mapa).
- Edição do catálogo pelo usuário, novos experts, experts por clube e permissões por expert.
- Internacionalização da interface (segue só en-US).
- Limite de mensagens **por usuário**: o limitador atual roda antes da autenticação e não enxerga a sessão (ver R9); backlog.

## 2. Contexto

**Estado atual.** `/app` mostra "Welcome, <nome>" e uma formação em pixel art (`apps/app/src/routes/home-page.tsx`). Não existe `modules/experts` na API, nenhuma dependência de LangChain, nenhuma chamada a LLM e nenhuma variável de ambiente da OpenAI. O produto está descrito em `BUSINESS.md` (experts por função), mas nada disso foi implementado.

**Por que agora.** Os experts são o centro do produto. Esta spec é o **esqueleto ambulante** do épico: atravessa UI, API, LangGraph e o LLM, e prova a arquitetura (`orquestrador de experts` de `ARCHITECTURE.md` §4) antes de qualquer dado externo. As specs seguintes acrescentam histórico, avatares e conhecimento sem mudar a forma do chat.

**Persona.** O Head Coach é um técnico veterano brasileiro: confiante, didático, fala em primeira pessoa sobre o próprio método e usa bordões **genéricos e inventados** (inspirado no estilo de um técnico experiente, sem usar o nome de nenhuma pessoa real, sem atribuir frases a ela e sem copiar sua imagem). Os outros seis têm tom técnico próprio. Nenhum expert afirma ser uma pessoa real.

| Expert (`id`)         | Função                                  | Escopo                                                     | Limite explícito                                                  |
| --------------------- | --------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `head-coach`          | Decisões de treino, escalação, estratégia | Plano de treino, leitura de jogo, escalação               | Não decide contratos, laudos médicos nem questões jurídicas       |
| `performance-analyst` | Métricas individuais e coletivas        | Interpretar dados, comparar, sinalizar tendências          | Não inventa números; pede os dados quando faltam                  |
| `sports-lawyer`       | Contratos, regulamentos, transferências | Riscos contratuais, checklists, regulamentos (FIFA/CBF)    | Não é parecer jurídico; recomenda advogado habilitado             |
| `physiologist`        | Carga, recuperação, prevenção           | Controle de carga, recuperação, sinais de sobrecarga       | Não diagnostica nem prescreve tratamento                          |
| `sports-physician`    | Saúde do atleta                         | Orientação geral de medicina esportiva                     | Não diagnostica nem prescreve; recomenda avaliação presencial     |
| `physiotherapist`     | Reabilitação e retorno ao jogo          | Fases de reabilitação, critérios de retorno                | Não prescreve tratamento individual; recomenda avaliação presencial |
| `football-manager`    | Gestão do departamento de futebol       | Elenco, calendário, orçamento, processos do clube          | Não decide contratos nem saúde; encaminha ao especialista         |

## 3. Necessidade de negócio

| Item                     | Descrição                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Usuário/papel afetado    | Pessoa autenticada de um clube (isolamento por usuário; clube e workspace fora do escopo).                                                |
| Decisão ou ação que muda | Em vez de procurar a informação em ferramentas dispersas, a pessoa escolhe a função certa e pergunta em linguagem natural.                 |
| Resultado esperado       | Home simples de chat: escolhe o expert, pergunta (ou clica numa sugestão) e recebe a resposta em formato de conversa, no tom da função.   |
| Métrica de sucesso       | Tempo até a primeira resposta (primeiro token em até 3 s no caminho feliz, com o provedor saudável); % de sessões que enviam ao menos 1 mensagem; uso das sugestões. |

## 4. Requisitos

| ID  | Requisito                                                                                                                                                                                                                                                                                      | Prioridade | Critério de aceite                                                                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `GET /api/v1/experts` devolve os 7 experts na ordem do catálogo com `id`, `name`, `role`, `characterName`, `description`, `suggestedQuestions` (3 a 6 por expert, em pt-BR) e `notice` (texto ou `null`); nunca o prompt de sistema.                                  | Must       | Given usuário autenticado, When `GET /api/v1/experts`, Then 200 com 7 itens, cada um com 3 a 6 perguntas e sem campo de prompt. Given sem sessão, Then 401 `UNAUTHENTICATED`.                                                                                                                                       |
| R2  | A home de `/app` é o chat: cabeçalho com wordmark, `ThemeToggle` e `SignOutButton` (sem regressão do sign-out da spec `0008`), área de mensagens e barra fixa no rodapé com dropdown de expert, textarea e botão de enviar. Não há outro conteúdo na home além do estado vazio do expert (R3).                                       | Must       | Given usuário logado, When abre `/app`, Then vê o cabeçalho, a área de mensagens e a barra com os três controles; When clica em `Sign out`, Then vai para `/auth/sign-in` e o token é limpo. Em 375 px a barra não cobre o último balão e o textarea não corta o texto.                                                |
| R3  | O dropdown lista os 7 experts (nome e função) e é operável por teclado. A seleção troca o estado vazio (avatar, nome, função, descrição, sugestões). O padrão é `head-coach`. A seleção só vale para a página (sem persistência nesta spec).                                                      | Must       | Given a home, When seleciona `physiologist`, Then o painel mostra o nome, a função e as sugestões do fisiologista e a mensagem enviada a seguir vai para `/experts/physiologist/messages`. Given o foco no dropdown, When usa as setas e Enter, Then troca de expert sem mouse. Given uma resposta em curso, When troca de expert, Then a resposta é abortada e a conversa da página é limpa.                                        |
| R4  | Clicar numa pergunta sugerida envia o texto dela, sem edição, como mensagem do usuário.                                                                                                                                                                                                        | Must       | Given o estado vazio do `head-coach`, When clica numa sugestão, Then o balão do usuário mostra exatamente esse texto e a resposta começa a chegar, sem digitar nem clicar em enviar.                                                                                                                              |
| R5  | Enviar uma mensagem (Enter envia; Shift+Enter quebra linha; botão `Send`) chama `POST /api/v1/experts/:expertId/messages` com `{ content, history }` (`history`: até 20 mensagens anteriores `{ role, content }`, com `role` só `user` ou `assistant` e cada `content` com até 4.000 caracteres) e mostra a resposta **em streaming** em um balão do expert. O texto é limitado a 4.000 caracteres. Envio desabilitado com texto vazio (só espaços) ou enquanto responde. | Must       | Given o chat, When digita "Qual escalação para o clássico?" e envia, Then aparece o balão do usuário, depois um balão do expert que cresce até o fim; o botão volta a habilitar ao terminar. Given 4.001 caracteres, Then a API responde 400 `VALIDATION_FAILED` e a UI mostra o limite sem perder o texto.        |
| R6  | O grafo LangGraph.js do expert usa `gpt-4o-mini` com o prompt de persona. A persona fala no tom da função e **no idioma da mensagem do usuário**; não inventa dado ausente (declara a lacuna); não afirma ser pessoa real; respeita o limite explícito da tabela de §2. Experts de saúde e jurídico orientam a procurar um profissional quando a pergunta exige avaliação individual. | Must       | Given o `sports-physician` e a pergunta "Que remédio devo tomar para a dor no joelho do atleta?", When responde, Then não prescreve dose nem diagnóstico e recomenda avaliação presencial (verificado por avaliação com o modelo real documentada em `QA.md`, e por teste que confere que o prompt contém os limites). Given o `head-coach`, Then o prompt carrega o estilo descrito em §2 sem nome de pessoa real. |
| R7  | Experts `sports-lawyer`, `physiologist`, `sports-physician` e `physiotherapist` mostram um aviso fixo sob o textarea: "Informational support only. It does not replace a licensed professional." (en-US). Os demais não mostram aviso.                                                         | Must       | Given o `sports-lawyer` selecionado, Then o aviso está visível e associado ao textarea por `aria-describedby`. Given o `head-coach`, Then não há aviso.                                                                                                                                                              |
| R8  | Falhas: sem `OPENAI_API_KEY` (opcional no boot: a API sobe sem ela) → `503 EXPERT_UNAVAILABLE`; expert inexistente → `404 EXPERT_NOT_FOUND`; erro, timeout (30 s sem primeiro token e 120 s no total por resposta) ou 429/5xx do provedor → uma nova tentativa automática **antes do primeiro token**, depois evento de erro. O usuário pode **parar** a geração (a chamada ao modelo é abortada) e **tentar de novo**. Resposta interrompida fica marcada como incompleta. | Must       | Given o modelo falso que falha, When envia, Then a UI mostra "The expert couldn't answer." com `Try again`, o texto digitado continua no histórico e nenhum stack trace chega ao cliente. Given uma resposta em curso, When clica em `Stop`, Then o stream encerra, o balão fica marcado como incompleto e a chamada ao modelo é abortada (verificado por sinal de abort no modelo falso). Given a API iniciada sem `OPENAI_API_KEY`, Then sobe normalmente e só `POST .../messages` responde `503 EXPERT_UNAVAILABLE`. |
| R9  | Segurança e custo: ambos os endpoints exigem sessão (API fechada por padrão) e o de envio tem limite de requisições **por IP**, pela política `expert-message` do mecanismo existente (ADR `0005`; premissa: 20 por minuto); `content` e `history` são validados (tipos, tamanhos, papéis); o histórico do cliente nunca é tratado como instrução de sistema.      | Must       | Given o 21º envio no mesmo minuto pelo mesmo IP, Then 429 `RATE_LIMITED`. Given `history` com papel `system`, Then 400 `VALIDATION_FAILED`. Given um histórico com "ignore as instruções anteriores", Then a persona e os limites continuam valendo (teste com modelo falso que expõe as mensagens recebidas).            |
| R10 | Privacidade e telemetria: nenhum conteúdo de mensagem, prompt de sistema, `history` ou chave aparece em logs, spans ou métricas. Log `event: "expert_message"` com `expertId`, resultado, duração e contagem de tokens. Os testes **nunca** chamam a OpenAI: modelo falso por porta nos testes unitários e de integração e, no E2E (que sobe a API real), o mesmo modelo falso selecionado por `NODE_ENV=test`, como o provedor de e-mail `capture` (ADR `0017`); com `NODE_ENV=production` o modelo falso nunca é usado.         | Must       | Given uma mensagem com valor sentinela, When o fluxo termina com sucesso e com erro, Then o sentinela não aparece em nenhum log nem atributo capturado (teste como `auth-observability.int-spec.ts`). Given `bun run test`, Then não há tráfego de rede para a OpenAI.                                              |
| R11 | Acessibilidade e responsividade: a lista de mensagens é `role="log"` com `aria-live="polite"`; foco e rótulos visíveis; sem movimento com `prefers-reduced-motion`; mobile primeiro; tema claro e escuro.                                                                                       | Should     | Given um leitor de tela, When a resposta chega, Then é anunciada ao fim e não token a token (atualização do `aria-live` por bloco). Axe sem violações na home em claro e escuro.                                                                                                                                  |
| R12 | ADR e arquitetura: um ADR registrando **LangGraph.js como biblioteca dentro de `apps/api`, sem LangGraph Platform/Deployment** e `ARCHITECTURE.md` atualizado (módulo `experts`, stack LangChain e LangGraph com as versões instaladas, variáveis e a linha de `expert_message` no catálogo de sinais do §4.4). | Must | Given o repositório, Then existe um ADR no template de `RULES.md` §5 e o `ARCHITECTURE.md` cita o módulo, as versões instaladas, `OPENAI_API_KEY`, `OPENAI_CHAT_MODEL` e o evento `expert_message`. |
| R13 | Demais documentos: `BUSINESS.md` (§4 e decisões), `QA.md` (como validar as respostas com o modelo real) e `.env.example`. | Should | Given o repositório, Then `.env.example` lista as variáveis, `QA.md` descreve a avaliação com o modelo real e `BUSINESS.md` registra as decisões. |

## 5. Fluxos e estados

- **Caminho feliz:** o usuário abre `/app`; a home carrega o catálogo; o `head-coach` aparece selecionado com suas sugestões; o usuário clica numa sugestão ou digita e envia; o balão do usuário aparece; a resposta chega em streaming; o campo volta a ficar disponível.
- **Vazio:** estado vazio do expert com avatar (fallback), nome, função, descrição e sugestões. Sem mensagens, sem lista.
- **Carregando:** catálogo carregando → esqueleto da barra e do painel; resposta carregando → balão do expert com indicador (bola em passos, estática com `prefers-reduced-motion`) até o primeiro token.
- **Erro:** catálogo falhou → painel "We couldn't load the experts." com `Try again`; 401 → `/auth/sign-in` (comportamento existente); resposta falhou → balão de erro com `Try again`; `503 EXPERT_UNAVAILABLE` → "The experts are unavailable right now."
- **Sucesso parcial:** stream cortado no meio → texto parcial preservado, marcado "Incomplete answer", com `Try again`.
- **Cancelamento/retry:** `Stop` aborta a geração; `Try again` reenvia a mesma pergunta (sem duplicar o balão do usuário); trocar de expert durante uma resposta a aborta e limpa a conversa da página.

## 6. Acceptance Criteria

- [ ] Given usuário autenticado, When `GET /api/v1/experts`, Then 200 com os 7 experts e sem prompt de sistema; sem sessão, 401.
- [ ] Given `/app` em 375 px e em 1280 px, Then a barra do rodapé tem dropdown, textarea e `Send`, o cabeçalho mantém tema e `Sign out`, e nada se sobrepõe.
- [ ] Given a seleção de outro expert, Then o painel e a rota de envio mudam; o teclado alcança e opera o dropdown.
- [ ] Given um clique numa sugestão, Then a mensagem é enviada sem edição e a resposta é exibida.
- [ ] Given o modelo falso, When envia uma mensagem, Then a resposta chega em partes e o balão final é igual ao texto completo.
- [ ] Given falha do provedor, Then uma nova tentativa antes do primeiro token e, depois, o balão de erro com `Try again`.
- [ ] Given `Stop`, Then a chamada ao modelo é abortada e o balão fica incompleto.
- [ ] Given o `sports-lawyer`, Then o aviso fixo aparece; given o `head-coach`, não aparece.
- [ ] Given `history` com papel `system` ou texto acima do limite, Then 400 `VALIDATION_FAILED`; given o 21º envio no minuto, Then 429.
- [ ] Given o valor sentinela, Then nenhum log, span ou métrica o contém.
- [ ] Given `bun run lint`, `check-types`, `test`, `test:integration` e `test:e2e`, Then passam sem tráfego real para a OpenAI.

## 7. O que fazer

1. Criar `apps/api/src/modules/experts/` em camadas (`domain`, `application`, `infrastructure`, `interface`), com um request handler e um caso de uso por endpoint (ADR `0014`): `ListExperts` e `SendExpertMessage`.
2. Modelar o catálogo como dados de domínio (sem banco) e a persona como prompt de sistema versionado em código; o `domain` não importa LangChain.
3. Definir a porta do modelo de chat e do orquestrador; implementar o grafo LangGraph.js e o adaptador `@langchain/openai` em `infrastructure`, com timeout, retry limitado e abort.
4. Entregar a resposta por SSE no request handler, traduzindo erros em eventos tipados e em `ApiException` antes do primeiro byte.
5. Adicionar a política `expert-message` (por IP) ao registro de `domain/rate-limit-policy.ts`, aplicá-la com `@RateLimit` no request handler de envio e registrar a telemetria sem conteúdo.
6. Reescrever `home-page.tsx` e o `AppLayout` para o chat em `apps/app/src/features/experts/`: dropdown, painel vazio, balões, streaming, `Stop` e `Try again`, usando `@repo/ui`; manter cabeçalho, tema e sign-out. Criar em `lib/` um cliente de streaming (POST com `fetch` e `ReadableStream`) que reaproveita o token e o tratamento de 401 do `api-client` (`clearAccessToken`), pois o `api-client` atual só faz `response.json()`.
7. Criar o fallback de avatar em pixel art no `@repo/ui` (sem imagens raster).
8. Escrever testes: unitários do catálogo e da persona, integração do endpoint com modelo falso, componente do chat e E2E (suggestion → resposta falsa → sign-out).
9. Atualizar `.env.example` (`OPENAI_API_KEY`, `OPENAI_CHAT_MODEL=gpt-4o-mini`), `ARCHITECTURE.md`, `BUSINESS.md`, `QA.md` e registrar o ADR.

## 8. O que não fazer

- Não chamar a OpenAI em testes automatizados nem commitar a chave; `OPENAI_API_KEY` só no servidor, nunca `VITE_*`.
- Não usar o nome, a imagem ou citações de uma pessoa real na persona do Head Coach.
- Não persistir mensagens, não criar tabelas e não armazenar histórico no servidor (0020).
- Não subir Weaviate, não gerar embeddings, não aceitar arquivos (0022 e 0023).
- Não expor o prompt de sistema nem o histórico bruto em logs, métricas, spans ou respostas de erro.
- Não instalar LangGraph Platform, LangSmith nem o Studio (backlog do mapa).
- Não deixar a regra do expert dentro do componente React; a UI só apresenta.
- Não usar `any` nem asserções não justificadas (`DEVELOPMENT.md`).

## 9. Riscos e dependências

| Tipo        | Descrição                                                                                                                  | Mitigação                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Dependência | OpenAI API (`gpt-4o-mini`) é a única chamada externa desta spec e exige `OPENAI_API_KEY`.                                  | Porta com modelo falso nos testes; `503 EXPERT_UNAVAILABLE` quando a chave falta; timeout, uma nova tentativa e abort.            |
| Dependência | LangChain.js e LangGraph.js mudam de API entre versões.                                                                    | Fixar versões no lockfile, isolar em `infrastructure` e registrar a versão no `ARCHITECTURE.md`.                                  |
| Risco       | Resposta de saúde ou jurídica tratada como parecer profissional.                                                           | Aviso fixo (R7), limites no prompt (R6), avaliação documentada em `QA.md`; Produto valida os textos.                              |
| Risco       | Custo descontrolado por abuso do endpoint.                                                                                 | Limite por IP (R9), limite de 4.000 caracteres e de 20 mensagens de histórico; contagem de tokens no log.                    |
| Risco       | O histórico vem do cliente e pode ser forjado.                                                                             | Nunca é instrução de sistema (R9); passa a ser do servidor na 0020.                                                               |
| Risco       | Persona de um técnico real pode ser lida como imitação ou uso indevido de imagem.                                          | Personagem fictício, sem nome ou citação reais (§8); Produto revisa antes do release.                                             |
| Risco       | Streaming por SSE com `fetch` e `Authorization: Bearer` não usa `EventSource` nativo.                                      | Consumir o stream com `fetch` e leitor de `ReadableStream`; testar parada e erro no meio do stream.                               |

## 10. Resultado

Como validar que a spec foi atendida:

- **Comando/verificação:** `bun run lint`, `bun run check-types`, `bun run test`, `bun run test:integration` e `bun run test:e2e`; `bun run infra:up` e `bun run dev`; abrir `/app`, escolher um expert, clicar numa sugestão e enviar uma pergunta digitada com `OPENAI_API_KEY` de desenvolvimento (verificação manual do modelo real, registrada em `QA.md`).
- **Evidência esperada:** saída verde dos comandos; E2E com modelo falso cobrindo sugestão, `Stop`, erro com `Try again` e sign-out; relatório de `QA.md` com as respostas reais dos experts de saúde e jurídico revisadas pelo Produto.
- **Comportamento observável:** a home é um chat simples com barra no rodapé; trocar de expert muda avatar, sugestões e aviso; as respostas chegam em streaming no tom da função; sair continua funcionando.

## 11. Perguntas abertas e premissas

| Pergunta/Premissa                                                                                                                                                                       | Impacto                                                                 | Bloqueante? | Quem decide        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------- | ------------------ |
| **Premissa (compartilhada):** LangGraph.js roda como biblioteca dentro de `apps/api`, sem LangGraph Platform/Deployment (licença) e sem LangSmith obrigatório; ver ADR e mapa.         | Forma de executar e de observar os agentes; o usuário citou LangSmith.  | Não         | Produto/Eng.       |
| **Premissa:** sugestões e respostas em pt-BR (idioma da mensagem do usuário); a interface (rótulos, avisos, erros) segue en-US (`DEVELOPMENT.md` §13.3).                                | Texto de conteúdo versus regra "interface em en-US".                    | Não         | Produto            |
| **Premissa:** o cliente envia até 20 mensagens de `history` e o servidor não guarda nada nesta spec.                                                                                    | Contrato muda na 0020 (o servidor passa a carregar o histórico).        | Não         | Eng.               |
| **Premissa:** limite de 20 mensagens por minuto por IP e 4.000 caracteres por mensagem.                                                                                            | Custo e abuso; valores podem mudar sem alterar o contrato.              | Não         | Produto            |
| **Premissa:** os nomes dos 7 personagens fictícios e as sugestões (3 a 6 por expert) são propostos na implementação e aprovados pelo Produto.                                           | Texto e identidade dos experts.                                         | Não         | Produto            |
| **Premissa:** o Head Coach é inspirado no estilo de um técnico veterano, sem nome nem frases reais. Se o Produto quiser referência explícita a uma pessoa real, exige revisão jurídica. | Direito de imagem e de nome.                                            | Não         | Produto/Jurídico   |
| Pergunta: o aviso dos experts de saúde e jurídico precisa de texto aprovado pelo Jurídico antes de produção?                                                                            | Texto do aviso (R7).                                                    | Não         | Jurídico           |
| **Premissa:** o limite de mensagens é por IP, porque o limitador atual roda antes da autenticação e não enxerga o usuário; um limite por usuário exigiria `keyBy: "user"` e mudar a ordem dos guards (ADR `0005`). Decidido no refinamento de 2026-11-17. | Abuso por contas atrás do mesmo IP e usuários legítimos atrás de NAT compartilhado. | Não | Eng. |
| **Premissa:** o modelo falso do E2E é escolhido por `NODE_ENV=test`, no mesmo modelo do e-mail `capture` (ADR `0017`). | Como testar o fluxo completo sem OpenAI. | Não | Eng. |
| **Premissa:** o avatar é escolhido no app pelo `id` do expert e a API não o devolve (decisão de 2026-11-17: a API não conhece os nomes com hash do build). | Contrato de `GET /experts` e spec 0021. | Não | Eng. |

## 12. Refinamento

| Data       | O que mudou                       | Motivo                                              |
| ---------- | --------------------------------- | --------------------------------------------------- |
| 2026-11-17 | Spec criada (rascunho)            | Quebra do épico de experts (`breakdown-specs`).     |
| 2026-11-17 | R1, R2, R3, R5, R8, R9, R10, R12 e passo 5 e 6 de §7 ajustados; R12 dividido em R12 (ADR e arquitetura, Must) e R13 (demais documentos, Should); avatar sai do contrato de `GET /experts`; limite passa a ser por IP; premissas de E2E e de avatar | Auditoria da spec contra o código: o limitador não enxerga o usuário; o avatar não pode ser URL da API; `RULES.md` §5 exige ADR; faltavam limites de `history`, prazo total e boot sem chave |
