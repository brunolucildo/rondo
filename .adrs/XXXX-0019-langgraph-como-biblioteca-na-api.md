# XXXX — LangGraph.js como biblioteca dentro da API, sem LangGraph Platform

- **Status:** aceito
- **Data:** 2026-11-17
- **Spec:** `0019-experts-chat-home` (número provisório: o orquestrador renumera)

## Contexto

Os experts do Rondo respondem por um LLM. A spec `0019` entrega o esqueleto ponta a ponta (UI, API, grafo e modelo) e as specs seguintes acrescentam histórico (`0020`), conhecimento no Weaviate (`0022`, `0023`) e citações (`0024`). O orquestrador de experts de `ARCHITECTURE.md` §4 precisa de um grafo de execução (nós, estado, streaming, abort) que cresça sem reescrever o chat. LangGraph.js oferece isso como biblioteca; o LangGraph Platform/Deployment e o LangSmith são serviços (licença ou nuvem) e estão fora do escopo do épico.

## Decisão

1. **LangGraph.js roda como biblioteca dentro de `apps/api`**, no módulo `modules/experts`, sem LangGraph Platform/Deployment, sem Studio e sem LangSmith. O grafo e o `ChatOpenAI` ficam em `infrastructure`; o `domain` define só as portas (`ExpertOrchestrator`, catálogo e persona) e não importa LangChain.
2. **Pacotes instalados:** `@langchain/core`, `@langchain/openai` e `@langchain/langgraph` (versões no lockfile e em `ARCHITECTURE.md` §3.1). O pacote guarda-chuva `langchain` **não** é instalado: nada dele é usado.
3. **Modelo `gpt-4o-mini`** (`OPENAI_CHAT_MODEL` troca), `maxRetries: 0` no cliente: a política de tentativa é do caso de uso `SendExpertMessage` (30 s sem primeiro token, 120 s no total, uma nova tentativa antes do primeiro token em erro, timeout, 429 ou 5xx; abort do cliente propaga ao modelo).
4. **Streaming por SSE** (`text/event-stream`) em `POST /api/v1/experts/:expertId/messages`, com os eventos `delta`, `done` e `error`. O grafo usa `streamMode: "custom"` e `config.writer` no nó `respond`, para o contrato de eventos não depender dos internos do modo `messages`. O SPA consome o stream com `fetch` e `ReadableStream` (o `EventSource` não envia `Authorization`).
5. **Sem chave, a API sobe:** `OPENAI_API_KEY` é opcional no boot e só o envio responde `503 EXPERT_UNAVAILABLE`.
6. **Modelo falso por `NODE_ENV=test`**, no mesmo molde do e-mail `capture` (ADR `0017`): o grafo real roda sobre um `ScriptedChatModel` que nunca usa a rede, no teste de integração e no E2E. `production` nunca o usa.
7. **Privacidade:** conteúdo de mensagem, `history`, prompt de sistema e chave nunca vão a log, span ou métrica; só `expertId`, resultado, duração e contagem de tokens (`event: "expert_message"` e span `expert.message`).

## Alternativas consideradas

| Alternativa                                      | Prós                                           | Contras                                                                         | Por que não                                                              |
| ------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| SDK `openai` direto, sem grafo                   | Menos dependências, código mais curto          | Cada passo novo (recuperação, citações) vira código ad hoc                      | O épico precisa de nós e estado; reescrever depois custa mais            |
| LangChain (`langchain`) sem LangGraph            | Cadeias prontas                                | Fluxo linear; sem estado nem ramificação explícitos                             | O grafo é o que as specs 0022 a 0024 estendem                            |
| LangGraph Platform/Deployment e LangSmith        | Studio, traces ricos, avaliação offline        | Licença ou serviço em nuvem, dado do usuário fora da API                        | Fora do escopo; backlog do mapa                                          |
| `streamMode: "messages"`                         | Tokens sem código no nó                        | O formato depende de detalhes internos que mudam entre versões                  | O contrato de eventos precisa ser estável                                |
| `EventSource` nativo                             | API do navegador                               | Só GET e sem cabeçalho `Authorization`                                          | A API é fechada por padrão (bearer) e o envio é POST                     |

## Consequências

- Positivas: um grafo que as próximas specs estendem sem mudar a forma do chat; testes e E2E exercitam o LangGraph real sem tráfego para a OpenAI; sem serviço novo para operar.
- Negativas: a API de LangChain/LangGraph muda entre versões (isolada em `infrastructure`, versões fixas no lockfile); mais dependências em `apps/api`; limite por IP (o limitador roda antes da autenticação e não enxerga o usuário); o histórico vem do cliente até a `0020`.
- Impacto: `ARCHITECTURE.md` (§2, §3.1, §4.4, §4.8, §5), `BUSINESS.md`, `QA.md` (avaliação com o modelo real), `.env.example` (`OPENAI_API_KEY`, `OPENAI_CHAT_MODEL`) e a política de limite `expert-message` (20 por minuto por IP).
