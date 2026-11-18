# 0029 — Observabilidade dos agentes (OpenTelemetry no Grafana)

> Spec executável. Preencha todas as seções; `TODO` é lacuna, não requisito.
> Use `create-spec` para criar, `refine-spec` para auditar e `implement-me` para executar.

- **Status:** concluída (implementada em `feat/0029-experts-agent-observability`; revisão de cobertura dos tipos novos de conexão, `0026` a `0028`, pendente para a integração)
- **Slug:** 0029-experts-agent-observability
- **Data:** 2026-11-17
- **Atualizado em:** 2026-11-18
- **Owner:** Time de engenharia (sinais, dashboard e alertas); Produto (limites de qualidade)
- **Relacionados:** mapa `.plans/experts-breakdown.md` (fase 2); `.docs/ARCHITECTURE.md` §4.4 (catálogo de sinais, push OTLP, sem PII, `increase()` e eventos raros); ADRs `0010` (métricas por push OTLP) e `0016`; specs `0011` (observabilidade da API), `0012` (alertas), `0013` (Postgres); specs `0019`, `0022`, `0023`, `0024`, `0025`. **Depende de:** 0019, 0022, 0023, 0024 e 0025 (os sinais básicos que elas definem) e, se existirem, 0026 a 0028. **Destrava:** nenhuma spec.

## 1. Escopo

### Dentro do escopo

- **Traces do agente por OpenTelemetry:** um span por mensagem do expert, com filhos para cada nó do grafo LangGraph.js (`retrieve`, `generate`), para a chamada ao LLM, para os embeddings e para o índice, no mesmo pipeline OTLP já existente (API → Collector → Tempo).
- **Métricas dos experts** em push OTLP: duração da resposta, **tempo até o primeiro token**, **tokens de entrada e saída**, resultado por expert, trechos recuperados, taxa de lacuna ("sem fonte"), chamadas e falhas de OpenAI e Weaviate (e Gemini, se a 0028 existir).
- **Dashboard Grafana "Rondo — Experts"** provisionado em `infra/grafana/dashboards/` (respostas, latência, primeiro token, tokens, falhas, recuperação, ingestão de conexões) e **regras de alerta** provisionadas em um novo grupo `rondo-experts`.
- **Trava do LangSmith:** o tracing automático do LangChain.js para o LangSmith (`LANGSMITH_TRACING`, `LANGCHAIN_TRACING_V2` e variáveis legadas) é **desligado no boot**, com um evento de log quando alguém o ativar por engano.
- Atualização do catálogo de sinais em `ARCHITECTURE.md` §4.4, do teste `grafana-assets.spec.ts`, de `QA.md` e **ADR** (observabilidade dos agentes por OpenTelemetry; LangSmith fora).

### Fora do escopo

- Os sinais básicos de cada fatia (`expert_message`, `expert_retrieval`, `connection.ingestions`, `connection.deletions`, métricas do índice): **0019**, **0022** a **0025** (aqui eles são consumidos e completados).
- **LangSmith** em qualquer forma (SaaS, self-hosted, Studio, Evaluation, Deployment): backlog; exige licença ou envia dados a um terceiro.
- **Avaliação offline** da qualidade das respostas (dataset, LLM-as-judge): backlog.
- Armazenar **prompts, respostas, trechos ou perguntas** para depuração: **proibido** (ver §8).
- Contact point, e-mail, Slack ou paging dos alertas: o estado aparece só no Grafana, como na spec `0012`.
- Métricas de negócio por usuário e análise de uso por pessoa.
- Custo financeiro em moeda (só tokens e minutos, que o Produto converte).

## 2. Contexto

**Estado atual.** A API já exporta traces, métricas e logs por OTLP; há dashboard e 19 alertas para a API, o auth e o Postgres (`ARCHITECTURE.md` §4.4). As specs do épico adicionam, cada uma, um log e uma métrica mínimos, mas **ninguém enxerga o agente como um todo**: quanto demora a resposta, por que uma resposta falhou, quantos tokens custa cada expert, se o índice está lento.

**Por que OpenTelemetry e não LangSmith.** O pedido incluía "LangSmith Observability". O LangSmith self-hosted exige plano Enterprise e `LANGSMITH_LICENSE_KEY`, e o SaaS envia prompts e trechos de documentos (dados de saúde de atletas) a um terceiro. A decisão do épico (2026-11-17) é rodar o LangGraph local e observar por OpenTelemetry no Grafana que já existe. O LangChain.js, porém, **liga o tracing para o LangSmith sozinho** quando as variáveis de ambiente estão definidas; por isso a spec trava isso no boot.

**Regras que continuam valendo** (`ARCHITECTURE.md` §4.4): métricas por push, contadores perdem o primeiro incremento (eventos raros são contados pelos logs do Loki), nenhum PII em rótulo, atributo ou log, dimensões fechadas.

## 3. Necessidade de negócio

| Item                     | Descrição                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Usuário/papel afetado    | Pessoa que opera e evolui o produto (engenharia e Produto); indiretamente, quem usa os experts.                              |
| Decisão ou ação que muda | Passa a responder "o expert está lento, falhando ou caro?" com dados, e a agir antes da reclamação.                          |
| Resultado esperado       | Um dashboard e alertas dos experts, com traces ligados aos logs, sem nenhum conteúdo de usuário e sem enviar nada ao LangSmith. |
| Métrica de sucesso       | Dado um erro de resposta, achar o trace e o log correspondentes em até 2 minutos; 0 vazamentos de conteúdo nos testes; todos os alertas validados no Grafana. |

## 4. Requisitos

| ID  | Requisito                                                                                                                                                                                                                                                                                                                                              | Prioridade | Critério de aceite                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Traces:** cada mensagem do expert gera um span `expert.message` (filho do span HTTP) com atributos `expert.id`, `expert.outcome` (`success`, `failure`, `aborted`) e `expert.error_code` (só na falha); os nós do grafo geram filhos `expert.retrieve` e `expert.generate`; a chamada ao LLM, aos embeddings e ao índice geram spans CLIENT filhos (`gen_ai.*` e `db.*` quando couber). Status `ERROR` só em falha real; `aborted` por `Stop` não é erro. | Must       | Given uma mensagem com sucesso, Then o Tempo mostra a árvore `expert.message` → `expert.retrieve` → embeddings e índice, e `expert.generate` → LLM. Given falha do LLM, Then o span tem status `ERROR` e `expert.error_code`. Given `Stop`, Then `expert.outcome=aborted` e status não `ERROR`.                       |
| R2  | **Sem conteúdo:** nenhum atributo, evento ou log de span contém pergunta, resposta, prompt, trecho, nome de fonte, `userId`, `connectionId`, nome de tenant, URL, chave ou mensagem de exceção do provedor (só o código tipado). O SDK não captura corpo de requisição ou resposta HTTP nas chamadas de saída (OpenAI, Gemini, Weaviate).                  | Must       | Given o sentinela na pergunta, na resposta, no documento e no nome do arquivo, When o fluxo termina com sucesso, lacuna, falha e `Stop`, Then o sentinela não aparece em nenhum atributo de span, rótulo de métrica nem campo de log capturados (teste como `auth-observability.int-spec.ts`).                      |
| R3  | **Métricas (push OTLP, nomes e dimensões fechados):** `expert_message_duration_seconds_*` (`expert`, `outcome`), `expert_first_token_seconds_*` (`expert`), `expert_llm_tokens_total` (`expert`, `direction`: `input`/`output`), `expert_retrieval_hits_*` (`scope`: `all`/`attached`), `expert_grounded_total` (`grounded`: `yes`/`gap`/`skipped`), `expert_dependency_calls_total` (`dependency`: `openai`/`weaviate`/`gemini`, `outcome`). Buckets de duração em **segundos**. | Must       | Given respostas de dois experts, Then o Mimir tem as séries com os rótulos exatos acima e nenhum rótulo extra (teste lê os rótulos). Given um expert fora da lista de 7, Then vira `unknown`. Given `direction`, Then só `input` e `output`.                                                                                  |
| R4  | **Tempo até o primeiro token e tokens:** `expert_first_token_seconds` mede do recebimento da requisição ao primeiro token enviado ao cliente; `expert_llm_tokens_total` soma os tokens informados pelo provedor (entrada e saída); quando o provedor não informar o uso, não registra valor inventado.                                                    | Must       | Given o modelo falso que informa 120 tokens de entrada e 80 de saída, Then o contador sobe 120 e 80. Given um modelo sem informação de uso, Then o contador não muda e há um log `expert_usage_unavailable`. Given uma resposta em streaming, Then o primeiro token é medido uma vez por mensagem.                   |
| R5  | **Correlação:** cada span do agente carrega `trace_id`; os logs `expert_message` e `expert_retrieval` incluem `trace_id` e `span_id` (pino), de modo que o derived field do Loki abre o trace no Tempo e o Tempo abre os logs (configuração da spec `0011`).                                                                                          | Must       | Given uma resposta com erro, When abre o log no Grafana, Then o link abre o trace correspondente; When abre o trace, Then o link mostra os logs da mesma requisição.                                                                                                                                              |
| R6  | **Dashboard "Rondo — Experts"** provisionado (`infra/grafana/dashboards/experts-observability.json`): respostas por expert e resultado, latência p50/p95/p99, primeiro token p95, tokens por expert, falhas por código (contadas pelos **logs** do Loki, por serem raras), lacuna versus resposta ancorada, chamadas e falhas por dependência, duração da recuperação, ingestões e exclusões de conexões por `kind`. Sem dados é estado normal. | Must       | Given `docker compose restart grafana`, Then o dashboard existe na pasta "Rondo" e cada painel tem consulta válida; o teste `grafana-assets.spec.ts` confere os nomes de métricas contra o catálogo e falha se um painel referencia uma série inexistente.                                                       |
| R7  | **Alertas** em um novo grupo `rondo-experts` em `rondo-alerts.yaml`: taxa de falha das respostas alta, primeiro token p95 alto, falhas do Weaviate, falhas de OpenAI (429 e 5xx), taxa alta de falhas de ingestão de conexões (contadas pelos logs `connection_ingested`); a ausência de tráfego de experts com a API de pé **não** é alerta. `noDataState: OK`; sem contact point; cada regra com `uid` de até 40 caracteres, `for`, `severity` e limiar (`DEVELOPMENT.md` §7), eventos raros contados pelos logs do Loki; limiares documentados no `QA.md`. | Must       | Given `docker compose restart grafana`, Then as regras existem e estão válidas (`validate_provisioning_file` ou o teste de ativos) e uma simulação com falhas forçadas muda uma regra para `Firing`. Given sem tráfego, Then nenhuma regra dispara.                                                                |
| R8  | **Trava do LangSmith:** no boot, se qualquer variável de tracing do LangSmith (`LANGSMITH_TRACING`, `LANGCHAIN_TRACING_V2` ou legadas equivalentes) estiver ativa, a API a **desativa para o processo antes de criar modelos e grafos** e registra `event: "langsmith_tracing_disabled"` (sem valores de chaves). Nenhuma chamada de rede ao LangSmith acontece. | Must       | Given `LANGSMITH_TRACING=true` e uma chave no ambiente, When a API sobe, Then o tracing está desligado, o log existe e o teste com um endpoint falso do LangSmith confirma **zero** requisições durante uma mensagem completa.                                                                                          |
| R9  | **Falha da telemetria não derruba o chat:** se o Collector estiver fora do ar, as respostas continuam e os sinais são descartados em lote com timeout (`OTEL_EXPORTER_OTLP_TIMEOUT`), como na API.                                                                                                                                                  | Must       | Given o Collector parado, When envia mensagens, Then respondem normalmente, sem aumento de latência perceptível (mais de 50 ms no p95 em teste) e sem erro 5xx.                                                                                                                                                   |
| R10 | ADR e arquitetura: um ADR "Observabilidade dos agentes por OpenTelemetry, sem LangSmith" e `ARCHITECTURE.md` §4.4 com as linhas do catálogo (spans, métricas, logs) e a regra "LangSmith fora". | Must | Given o repositório, Then existe um ADR no template de `RULES.md` §5 e o `ARCHITECTURE.md` lista os nomes de métricas e rótulos desta spec. |
| R11 | Demais documentos: `QA.md` explica como ver o dashboard, simular falhas e interpretar os alertas; `.env.example` lembra que o tracing do LangSmith é desligado pela API. | Should | Given o repositório, Then `QA.md` descreve a simulação de falhas e os limiares e o `.env.example` não traz as variáveis de LangSmith ativas. |

## 5. Fluxos e estados

- **Caminho feliz:** o usuário conversa com um expert; a API cria o span `expert.message` e os filhos, mede o primeiro token e os tokens, exporta por OTLP; o dashboard "Rondo — Experts" mostra a resposta; um erro, se houver, tem log e trace ligados.
- **Vazio:** sem tráfego de experts o dashboard mostra "No data" e nenhum alerta dispara (`noDataState: OK`).
- **Carregando:** métricas e traces aparecem com o atraso normal do pipeline (lote, até ~15 s); o dashboard não depende de estado da interface do produto.
- **Erro:** Collector, Tempo, Mimir ou Loki fora do ar → o chat continua; os sinais do período se perdem; o dashboard mostra lacunas.
- **Sucesso parcial:** respostas interrompidas (`Stop`) contam como `aborted`, sem inflar a taxa de falha; provedor sem informação de uso → tokens sem valor e um log de aviso.
- **Cancelamento/retry:** `Try again` gera uma nova mensagem (novo span); a trava do LangSmith não pode ser reativada por variável em tempo de execução.

## 6. Acceptance Criteria

- [x] Given uma mensagem com sucesso, Then o Tempo mostra `expert.message` com `expert.retrieve`, `expert.generate`, embeddings, índice e LLM como filhos.
- [x] Given falha do LLM, Then status `ERROR` e `expert.error_code`; given `Stop`, Then `aborted` sem `ERROR`.
- [x] Given o sentinela (pergunta, resposta, documento, nome do arquivo), Then não aparece em atributo de span, rótulo de métrica ou campo de log.
- [x] Given respostas de dois experts, Then as séries do R3 existem com os rótulos exatos e nada além.
- [x] Given o modelo falso com e sem informação de uso, Then os tokens são contados só quando informados.
- [x] Given um erro de resposta, Then log e trace estão ligados nos dois sentidos no Grafana.
- [x] Given `docker compose restart grafana`, Then o dashboard e o grupo `rondo-experts` existem e são válidos; `grafana-assets.spec.ts` passa.
- [x] Given falhas forçadas, Then uma regra do grupo muda para `Firing`; given sem tráfego, Then nenhuma dispara.
- [x] Given `LANGSMITH_TRACING=true` no ambiente, Then a API o desliga, registra o evento e **zero** requisições vão ao LangSmith.
- [x] Given o Collector parado, Then o chat segue sem erro e sem latência extra relevante.
- [x] Given `bun run lint`, `check-types`, `test` e `test:integration`, Then passam sem chamar OpenAI, Gemini nem LangSmith.

## 7. O que fazer

1. Instrumentar o orquestrador de experts (spans `expert.message`, `expert.retrieve`, `expert.generate` e filhos CLIENT) no estilo de `traceAuthOperation` da spec `0011`, por trás de uma porta de telemetria para manter o `domain` sem OpenTelemetry.
2. Registrar as métricas do R3 no mesmo SDK (rótulos fechados, `unknown` para valores fora da lista), medir o primeiro token e somar os tokens informados pelo provedor.
3. Garantir que as chamadas de saída (OpenAI, Gemini, Weaviate) não capturam corpo, cabeçalhos nem URL com dados, reaproveitando `span-redaction.ts`.
4. Incluir `trace_id` e `span_id` nos logs `expert_message` e `expert_retrieval`.
5. Criar a trava do LangSmith no boot (antes de qualquer modelo ou grafo) e o evento `langsmith_tracing_disabled`.
6. Escrever o dashboard `experts-observability.json` e o grupo `rondo-experts` em `rondo-alerts.yaml`; atualizar `grafana-assets.spec.ts`.
7. Escrever os testes: unidade (rótulos fechados, tokens, primeiro token), integração (árvore de spans, `aborted`, sentinela, trava do LangSmith com endpoint falso, Collector parado) e verificação dos ativos do Grafana.
8. Atualizar `ARCHITECTURE.md` §4.4, `QA.md`, `.env.example` e registrar o ADR.

## 8. O que não fazer

- Não registrar prompts, respostas, trechos, perguntas, nomes de fontes, URLs, `userId`, `connectionId` ou nomes de tenant em spans, métricas ou logs; nem para depuração.
- Não ativar nem configurar o LangSmith (SaaS, self-hosted, Studio, Evaluation ou Deployment); não deixar o tracing automático do LangChain.js ligado.
- Não criar rótulos com cardinalidade aberta (id de usuário, de conexão, texto).
- Não contar eventos raros só por contadores OTLP (perdem o primeiro incremento): usar os logs do Loki, como no catálogo de §4.4.
- Não editar dashboards ou alertas pela interface do Grafana (o volume os perde); editar os arquivos provisionados e reiniciar o container.
- Não mudar `turbo.json` nem comandos do Turborepo.
- Não acrescentar contact point ou integrações de notificação.
- Não chamar OpenAI, Gemini nem LangSmith nos testes automatizados.

## 9. Riscos e dependências

| Tipo        | Descrição                                                                                                      | Mitigação                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Dependência | Specs 0019, 0022, 0023, 0024 e 0025 (sinais básicos) e a pilha LGTM da spec `0011`.                            | Implementar depois delas; completar em vez de substituir os sinais existentes.                                                         |
| Risco       | Conteúdo de usuário vazar por atributos automáticos de instrumentação (HTTP, undici, LangChain).               | R2 com teste de sentinela em todos os desfechos; reaproveitar a redação de spans; revisão de segurança antes do release.               |
| Risco       | O LangChain.js ativa o tracing do LangSmith por variável de ambiente herdada do computador do desenvolvedor.   | Trava no boot (R8) e teste com endpoint falso; `.env.example` sem as variáveis.                                                        |
| Risco       | Cardinalidade explosiva em métricas por rótulo aberto.                                                         | Rótulos fechados e `unknown` (R3); teste confere o conjunto de rótulos.                                                                |
| Risco       | Alertas ruidosos com pouco tráfego local.                                                                      | `noDataState: OK`, janelas e limiares com mínimo de amostras; limiares documentados e revisáveis no `QA.md`.                           |
| Risco       | Tokens do provedor ausentes em streaming distorcem o custo.                                                    | Contar só o informado e registrar `expert_usage_unavailable`; não estimar.                                                             |
| Risco       | Mudança nas convenções semânticas de `gen_ai.*` do OpenTelemetry (ainda em evolução).                          | Atributos mínimos e estáveis, documentados no catálogo; revisar na atualização do SDK.                                                 |

## 10. Resultado

Como validar que a spec foi atendida:

- **Comando/verificação:** `bun run infra:up`; `docker compose restart grafana`; `bun run lint`, `bun run check-types`, `bun run test`, `bun run test:integration`; conversar com dois experts (com e sem arquivo), forçar uma falha (chave inválida ou índice parado) e abrir o dashboard "Rondo — Experts", o trace e o log da requisição.
- **Evidência esperada:** teste de sentinela verde em sucesso, lacuna, falha e `Stop`; teste da trava do LangSmith com **zero** requisições; `grafana-assets.spec.ts` verde; captura do dashboard com dados; uma regra `Firing` na simulação; ADR registrado.
- **Comportamento observável:** o dashboard mostra volume, latência, primeiro token, tokens e falhas por expert, o trace da resposta liga ao log, nenhum conteúdo de usuário aparece em lugar algum e nada sai para o LangSmith.

## 11. Perguntas abertas e premissas

| Pergunta/Premissa                                                                                                                                      | Impacto                                                         | Bloqueante? | Quem decide        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------- | ------------------ |
| **Premissa (compartilhada):** observabilidade dos agentes por OpenTelemetry no Grafana existente; LangSmith (SaaS e self-hosted) fora do produto.        | Substitui "LangSmith Observability" do pedido original.         | Não         | Produto            |
| **Premissa:** limiares iniciais dos alertas (falha de respostas acima de 5% em 10 min, primeiro token p95 acima de 5 s, falhas de dependência acima de 10%) são ajustados com o uso. | Ruído versus cobertura.                                         | Não         | Eng./Produto       |
| **Premissa:** o trace guarda só identificadores técnicos e códigos de erro, nunca conteúdo, nem para depuração.                                          | Capacidade de depurar respostas ruins sem ver o texto.          | Não         | Produto/Jurídico   |
| Pergunta: o Produto aceita depurar respostas ruins só por métricas, traces e reprodução com dados de teste, já que o conteúdo não é guardado?            | Processo de qualidade e a futura spec de avaliação offline.     | Não         | Produto            |
| Pergunta: o Produto quer reabrir o LangSmith (licença Enterprise ou SaaS) para Evaluation e Studio no futuro?                                            | Backlog de avaliação e de Studio.                               | Não         | Produto            |
| **Premissa (execução orquestrada, 2026-11-18):** as ingestões de imagem (`0026`), URL (`0027`) e áudio/vídeo (`0028`) não foram instrumentadas aqui; os sinais de conexões e de dependências são genéricos por `kind` e `dependency`, e a revisão de cobertura dos tipos novos (motivos de falha, `gemini`) acontece na integração. | Painéis e alerta de ingestão podem precisar de ajuste fino. | Não | Eng. |
| **Premissa (execução, 2026-11-18):** `expert_retrieval_hits_*` (`scope` `all` ou `attached`) é um histograma novo ao lado de `expert_retrieval_chunks_*` da `0024` (`scope` `connections`), que continua como está, para não mudar o contrato da `0024`. | Duas séries do mesmo número até a `0024` ser simplificada. | Não | Eng. |
| **Premissa (execução, 2026-11-18):** falha de dependência (Weaviate, OpenAI) alerta por contagem absoluta nos logs (mais de 2 em 10 min), não por percentual de 10%, por ser evento raro; falha de ingestão conta só `processing_unavailable` (problema do arquivo é do usuário). | Ruído versus cobertura; ajustável no `QA.md` §1.23. | Não | Eng./Produto |
| **Premissa (execução, 2026-11-18):** um `Stop` e um estouro de timeout do primeiro token abortam o sinal da tentativa e não contam como falha da OpenAI no contador de dependências (o desfecho da mensagem, `timeout`, conta no `expert_message`). | Subcontagem de lentidão do provedor nos alertas de OpenAI. | Não | Eng. |

## 12. Refinamento

| Data       | O que mudou            | Motivo                                                  |
| ---------- | ---------------------- | ------------------------------------------------------- |
| 2026-11-17 | Spec criada (rascunho) | Fase 2 do épico de experts (`breakdown-specs`).         |
| 2026-11-17 | Cabeçalho (dependência da 0025), R7 (`uid`, `for`, `severity` e limiar) detalhado; R10 dividido em R10 (ADR e arquitetura, Must) e R11 (demais documentos, Should) | Auditoria: divergência com o mapa, regras de alerta do `DEVELOPMENT.md` §7 e `RULES.md` §5 (ADR) |
| 2026-11-18 | Status `concluída`; critérios marcados; premissas da execução (cobertura dos tipos novos de conexão, `hits` ao lado de `chunks`, alertas por contagem, `Stop` e timeout) | Implementação em worktree orquestrado (`implement-me`) |
