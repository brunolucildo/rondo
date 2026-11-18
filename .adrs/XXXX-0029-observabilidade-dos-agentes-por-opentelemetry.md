# XXXX — Observabilidade dos agentes por OpenTelemetry, sem LangSmith

> Número provisório (`XXXX`): o orquestrador renumera na integração (spec `0029`).

- **Status:** aceito
- **Data:** 2026-11-18

## Contexto

Os experts rodam em LangGraph.js dentro da API (ADR do LangGraph). Cada spec do épico acrescentou um log e uma métrica mínimos, mas ninguém enxerga o agente como um todo: quanto demora a resposta, até o primeiro token, quantos tokens custa cada expert, por que uma resposta falhou, se o índice ou o provedor estão lentos.

O pedido original citava "LangSmith Observability". Descartamos: o LangSmith self-hosted exige plano Enterprise e `LANGSMITH_LICENSE_KEY`, e o SaaS recebe os prompts e os trechos recuperados, que são dados de saúde de atletas, num terceiro. O pipeline OTLP já existe (API → Collector → Tempo, Mimir e Loki, ADR 0010) e o Grafana já tem dashboard e alertas.

O LangChain.js tem uma armadilha: liga o tracing para o LangSmith sozinho quando `LANGSMITH_TRACING` ou `LANGCHAIN_TRACING_V2` estão no ambiente, inclusive herdadas do computador de quem desenvolve. Confirmado em teste: com um endpoint falso, um grafo sem trava envia `POST /runs/multipart`.

## Decisão

- **Os agentes são observados por OpenTelemetry no Grafana existente.** Um span `expert.message` por mensagem, com filhos `expert.retrieve` e `expert.generate` (um por nó do grafo) e spans CLIENT para o chat (`gen_ai.chat`), os embeddings (`gen_ai.embeddings`) e o índice (`knowledge.index.*`, com `db.system.name=weaviate`).
- **Métricas de contrato fechado:** `expert_message_duration_seconds`, `expert_first_token_seconds`, `expert_llm_tokens_total`, `expert_retrieval_hits`, `expert_grounded_total` e `expert_dependency_calls_total`, com rótulos de conjuntos fechados (o `expert` fora dos 7 ids vira `unknown`). Tokens só quando o provedor informa; nada é estimado.
- **Nenhum conteúdo** (pergunta, resposta, prompt, trecho, nome de fonte, `userId`, `connectionId`, URL, chave, mensagem de exceção) em span, métrica ou log. A telemetria vive em `observability/`, a `application` e o `domain` seguem sem OpenTelemetry; a instrumentação entra no handler, no grafo (`infrastructure`) e nos decoradores do `knowledge`.
- **Eventos raros por log** (falha de resposta, de dependência e de ingestão), como no catálogo da `0011`; o contador OTLP perde o primeiro incremento. Os logs `expert_message` e `expert_retrieval` levam `trace_id` e `span_id` para o link log ↔ trace.
- **LangSmith fora, travado no boot:** `disableLangSmithTracing()` desliga as variáveis de tracing, apaga chaves e endpoints do LangSmith do `process.env` e registra `langsmith_tracing_disabled` (só nomes de variáveis). Roda em `createNestApp` e antes de criar o orquestrador.
- **Dashboard "Rondo — Experts" e o grupo de alertas `rondo-experts`** provisionados em arquivo; `grafana-assets.spec.ts` lê as declarações dos instrumentos e falha se um painel consulta série inexistente.
- Nenhuma dependência nova.

## Alternativas consideradas

| Alternativa                                                        | Prós                                     | Contras                                                                                       | Por que não                                                                      |
| ------------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| LangSmith SaaS                                                     | Traces de LLM prontos, avaliação, Studio | Envia prompts e trechos de documentos (saúde de atletas) a um terceiro                        | Risco de privacidade e jurídico; o Produto não aceitou                           |
| LangSmith self-hosted                                              | Dados ficam conosco                      | Exige plano Enterprise e licença; mais um serviço para operar                                 | Custo e operação desproporcionais para o estágio                                 |
| Biblioteca de instrumentação de LLM para OpenTelemetry (terceiros) | Atributos `gen_ai.*` prontos             | Dependência nova que pode capturar prompt e resposta por padrão; convenções ainda em evolução | Manual com atributos mínimos é pequeno e provado por teste de sentinela          |
| Guardar prompt e resposta no trace para depurar                    | Depuração mais fácil                     | Dado de saúde fora do banco do produto, sem retenção nem isolamento                           | Proibido pela spec; depurar por métricas, traces e reprodução com dados de teste |
| Só desligar o LangSmith por variável no `.env.example`             | Zero código                              | Variável herdada do computador ainda liga o tracing                                           | Não impede o vazamento; a trava no boot e o teste com endpoint falso impedem     |
| Contar falhas só por contador OTLP                                 | Um sinal só                              | Perde o primeiro incremento de uma série nova, então o alerta de evento raro falha            | Logs do Loki são exatos (mesma regra do catálogo da `0011`)                      |

## Consequências

- **Positivas:** um erro de resposta leva do log ao trace e de volta; latência, primeiro token, tokens e falhas por expert num dashboard; alertas sem ruído de "sem tráfego"; nada sai para terceiros; os testes de sentinela cobrem sucesso, lacuna, falha e `Stop`.
- **Negativas:** depurar uma resposta ruim não mostra o texto (só códigos, métricas e traces); os atributos `gen_ai.*` seguem convenções ainda em mudança (mínimos e documentados no catálogo); o `db.query.text` dos spans `pg` da instrumentação automática continua com o SQL parametrizado (sem valores, dívida da `0013`); o primeiro token e a duração incluem o tempo desde a requisição, e a espera da trava de conversa e a leitura do histórico entram na conta.
- **Impacto em código, operação e time:** métrica ou atributo novo de agente entra em `observability/` com rótulo fechado e no catálogo de `ARCHITECTURE.md` §4.4; painel novo só consulta séries que a API emite (teste); alteração de dashboard ou alerta é no arquivo e exige reiniciar o contêiner do Grafana; quem ligar o LangSmith vê o evento `langsmith_tracing_disabled`. Os tipos de conexão novos (`0026` a `0028`) entram nos painéis por `kind` e `dependency`; a revisão de cobertura (motivos de falha novos, `gemini`) é feita na integração dessas specs.
