# Plano — Observabilidade dos agentes (OpenTelemetry no Grafana)

- **Status:** concluído (gates verdes; 3 falhas pré-existentes em `session.service.spec.ts`)
- **Slug:** 0029-experts-agent-observability
- **Spec:** `.specs/0029-experts-agent-observability.md`
- **Data:** 2026-11-18

## Contexto

As specs `0019` a `0025` deixaram sinais mínimos dos experts (`expert.message`, `expert.retrieval`, `knowledge.*`, `connection.*`), mas ninguém enxerga o agente inteiro. O pedido original citava LangSmith; a decisão do épico é observar por OpenTelemetry no Grafana existente e travar o tracing automático do LangChain.js para o LangSmith.

## Objetivo

Árvore de spans por mensagem (nós do grafo, LLM, embeddings, índice), métricas de contrato fechado (duração, primeiro token, tokens, hits, ancoragem, dependências), logs ligados ao trace, dashboard "Rondo — Experts", grupo de alertas `rondo-experts` e a trava do LangSmith no boot, sem nenhum conteúdo de usuário em qualquer sinal.

## Não-objetivos

LangSmith em qualquer forma, avaliação offline, guardar prompt ou resposta, contact point dos alertas, métricas por usuário, custo em moeda, instrumentar as ingestões de imagem, URL e áudio/vídeo (`0026` a `0028`, que chegam depois).

## Usuários e permissões

Nenhuma superfície nova de API; a telemetria é interna. Dado sensível (conteúdo de conversa, trechos, nomes de arquivo, ids) nunca entra em rótulo, atributo ou log.

## Fluxos e estados

Sem tráfego: "sem dados" e nenhum alerta (`noDataState: OK`). Collector fora do ar: o chat segue e os sinais se perdem. `Stop` é `aborted`, não falha. Modelo sem informação de uso: sem tokens e um log `expert_usage_unavailable`.

## Requisitos

R1 a R11 da spec, critérios sem alteração.

## Contratos de dados

Métricas `expert_message_duration_seconds_*`, `expert_first_token_seconds_*`, `expert_llm_tokens_total`, `expert_retrieval_hits_*`, `expert_grounded_total`, `expert_dependency_calls_total`; spans `expert.retrieve`, `expert.generate`, `gen_ai.chat`, `gen_ai.embeddings`; logs `expert_dependency_failed`, `expert_usage_unavailable`, `langsmith_tracing_disabled`; `trace_id` e `span_id` em `expert_message` e `expert_retrieval`. Catálogo completo em `ARCHITECTURE.md` §4.4.

## Integrações

OpenTelemetry (SDK e Collector já existentes), Grafana (arquivos provisionados). Sem dependência nova.

## Decisões e premissas

- Decisão: telemetria em `observability/` (`agent-telemetry.ts`, `langsmith-guard.ts`, `expert-telemetry.ts`); `domain` e `application` seguem sem OpenTelemetry; o primeiro token é medido por um `ExpertMessageProbe` que o handler passa a `writeAnswerStream`.
- Decisão: `expert_retrieval_hits_*` é novo ao lado de `expert_retrieval_chunks_*` (`0024`), para não mudar o contrato da `0024`.
- Decisão: falhas de dependência e de ingestão alertam por contagem nos logs; taxas exigem mínimo de 5 amostras.
- Decisão: a trava do LangSmith roda em `createNestApp` e em `createExpertOrchestrator`, põe as chaves em `false` (inclusive as ausentes) e apaga chaves e endpoints.
- Premissa: os tipos novos de conexão (`0026` a `0028`) entram por `kind`; revisão de cobertura na integração.
- Premissa: o Grafana compartilhado monta os arquivos do repositório principal; os ativos desta branch foram validados num Grafana descartável.

## Abordagem (fatias verticais)

1. Instrumentação dos experts: spans, métricas, tokens, primeiro token, correlação, trava do LangSmith e testes unitários.
2. Testes de integração: árvore, rótulos, sentinela, `Stop`, trava com endpoint falso e Collector parado.
3. Dashboard e grupo de alertas provisionados e o teste `grafana-assets.spec.ts`; validação ao vivo.
4. Documentação (`ARCHITECTURE.md` §4.4, `QA.md`, `.env.example`), ADR e gates.

## Arquivos previstos

`apps/api/src/observability/{agent-telemetry,langsmith-guard,expert-telemetry,knowledge-telemetry,telemetry}.ts` (+ specs), `apps/api/src/modules/experts/{infrastructure,interface}/...`, `apps/api/src/modules/knowledge/infrastructure/instrumented.ts`, `apps/api/src/bootstrap.ts`, `apps/api/test/experts-{observability,telemetry-resilience}.int-spec.ts`, `infra/grafana/dashboards/experts-observability.json`, `infra/grafana/provisioning/alerting/rondo-alerts.yaml`, `.docs/{ARCHITECTURE,QA}.md`, `.env.example`, ADR.

## Estratégia de testes

Unidade: rótulos fechados, tokens, primeiro token, status do span, trava. Integração: árvore de spans, séries e rótulos, sentinela em sucesso, lacuna, falha e `Stop`, LangSmith com endpoint falso (e o controle), Collector parado. Ativos do Grafana por teste e ao vivo. E2E: regressão do chat.

## Riscos e rollback

- Risco: conteúdo vazar por atributo automático (HTTP, undici, LangChain). Mitigação: teste de sentinela e redação existente.
- Risco: ruído de alertas com pouco tráfego. Mitigação: amostra mínima e `noDataState: OK`.
- Como reverter: reverter o commit; os sinais novos somem e nenhum dado muda.

## Critério de pronto

- [x] Gates (lint, tipos, build, unitário, integração, E2E) executados; baseline conhecido registrado
- [x] Dashboard e regras validados ao vivo; uma regra em `Firing` por falha forçada
- [x] ADR e `ARCHITECTURE.md` §4.4 atualizados

## Perguntas abertas

| Pergunta                                                                | Impacto                         | Bloqueante? | Quem decide |
| ----------------------------------------------------------------------- | ------------------------------- | ----------- | ----------- |
| Produto aceita depurar só por métricas, traces e dados de teste?        | Futura spec de avaliação offline | Não         | Produto     |
