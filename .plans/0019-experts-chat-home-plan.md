# Plano — Home de chat com experts

- **Status:** implementado (pendente: avaliação manual com o modelo real, sem `OPENAI_API_KEY`)
- **Slug:** 0019-experts-chat-home
- **Spec:** `.specs/0019-experts-chat-home.md`
- **Data:** 2026-11-17

## Contexto

`/app` mostra só "Welcome, <nome>" e uma formação em pixel art. Não existe `modules/experts`, dependência de LangChain, chamada a LLM nem variável da OpenAI. A spec é o esqueleto ambulante do épico de experts: UI, API, LangGraph e LLM.

## Objetivo

Home de chat em `/app`: catálogo fixo de 7 experts (`GET /api/v1/experts`), dropdown, estado vazio com sugestões, envio com resposta em streaming SSE (`POST /api/v1/experts/:expertId/messages`) por um grafo LangGraph.js com `gpt-4o-mini`, parar, tentar de novo, aviso nos experts de saúde e jurídico, cabeçalho com tema e sign-out mantidos.

## Não-objetivos

Persistência da conversa (0020), imagens dos avatares (0021), Weaviate e arquivos (0022 e 0023), citações (0024), limite por usuário, LangGraph Platform, LangSmith, métricas e spans por nó (0029), i18n.

## Usuários e permissões

Pessoa autenticada. Os dois endpoints exigem sessão (`AuthGuard` global, API fechada por padrão). O envio tem limite por IP (`expert-message`, 20 por minuto), porque o limitador roda antes da autenticação. O histórico vem do cliente e nunca é instrução de sistema.

## Fluxos e estados

- Feliz: abre `/app`, catálogo carrega, `head-coach` selecionado, clica numa sugestão ou digita, balão do usuário, balão do expert em streaming, campo volta a ficar disponível.
- Vazio: avatar (fallback pixel), nome, função, descrição e sugestões.
- Carregando: esqueleto da barra e do painel; indicador no balão até o primeiro token.
- Erro: catálogo (`We couldn't load the experts.` + `Try again`); 401 (comportamento existente); resposta (`The expert couldn't answer.` + `Try again`); 503 (`The experts are unavailable right now.`).
- Parcial: stream cortado, texto preservado e `Incomplete answer`.
- Cancelamento: `Stop` aborta; `Try again` reenvia sem duplicar o balão do usuário; trocar de expert aborta e limpa.

## Requisitos

R1 a R13 da spec (todos Must, exceto R11 e R13, Should).

## Contratos de dados

- `GET /api/v1/experts` → `{ experts: [{ id, name, role, characterName, description, suggestedQuestions, notice }] }` (sem prompt, sem avatar).
- `POST /api/v1/experts/:expertId/messages` body `{ content, history }` (`content` até 4.000 caracteres e não vazio; `history` até 20 itens `{ role: "user" | "assistant", content }`); resposta `text/event-stream` com os eventos `delta` (`{ text }`), `done` (`{}`) e `error` (`{ code: "EXPERT_ANSWER_FAILED", message }`). Antes do primeiro byte: envelope de erro (400, 401, 404 `EXPERT_NOT_FOUND`, 429, 503 `EXPERT_UNAVAILABLE`).
- Nada é persistido. Conteúdo de mensagem nunca vai a log, span ou métrica.

## Integrações

OpenAI `gpt-4o-mini` por `@langchain/openai` (`maxRetries: 0`; política própria: 30 s sem primeiro token, 120 s no total, uma nova tentativa antes do primeiro token em erro, timeout ou 429/5xx). Sem `OPENAI_API_KEY` a API sobe e só o envio responde 503. Testes e E2E usam um modelo de chat falso (`NODE_ENV=test`); `production` nunca o usa.

## Decisões e premissas

- Decisão: duas portas em `domain` (`ExpertOrchestrator` e o catálogo em código); o grafo LangGraph.js e o `ChatOpenAI` ficam em `infrastructure`; a política de timeout e retry fica no caso de uso (testável com o orquestrador falso).
- Decisão: o grafo usa `streamMode: "custom"` com `config.writer` no nó `respond`, para o contrato de eventos não depender dos internos do modo `messages`.
- Decisão: `langchain` (pacote guarda-chuva) não é instalado: nada dele é usado; entram `@langchain/core`, `@langchain/openai` e `@langchain/langgraph`.
- Decisão: dropdown com `<select>` nativo estilizado (`@repo/ui/select`): teclado e leitor de tela de graça, sem dependência nova.
- Decisão: a home mantém um `h1` só para leitor de tela ("Chat with the experts"), porque o conteúdo visível é o chat.
- Premissa: nomes dos personagens e perguntas sugeridas são propostas para aprovação do Produto.
- Premissa: ADR com número provisório `XXXX` (o orquestrador renumera).

## Abordagem (fatias verticais)

1. **Catálogo e `GET /experts`:** domínio (catálogo, persona, prompt), `ListExperts`, request handler, presenter, política `expert-message`, testes unitários e de integração.
2. **Envio com streaming:** configuração do LLM, portas, grafo LangGraph, modelo falso, `SendExpertMessage` (retry, timeouts, abort), SSE no request handler, telemetria sem conteúdo, testes unitários e de integração (inclusive sentinela).
3. **Primitivos de UI e cliente de streaming:** `PixelAvatar`, `Select`, `Textarea` em `@repo/ui`; `lib/stream-client.ts` no app.
4. **Home de chat:** `features/experts/` (catálogo, dropdown, painel vazio, balões, `Stop`, `Try again`, aviso), `AppLayout` e `home-page`; ajuste dos testes existentes que dependiam do "Welcome"; testes de componente.
5. **E2E, docs e ADR:** `e2e/experts-chat.spec.ts`, `a11y`, `.env.example`, `ARCHITECTURE.md`, `BUSINESS.md`, `QA.md`, `DEVELOPMENT.md`, ADR.

## Arquivos previstos

- `apps/api/src/modules/experts/**` — módulo novo.
- `apps/api/src/config/environment.ts`, `apps/api/src/app.module.ts`, `apps/api/src/observability/expert-telemetry.ts`, `apps/api/src/modules/rate-limit/domain/rate-limit-policy.ts` — configuração, módulo, telemetria e política.
- `apps/api/package.json`, `bun.lock` — dependências.
- `packages/ui/src/{pixel-avatar,select,textarea}.tsx`, `packages/ui/package.json` — primitivos.
- `apps/app/src/features/experts/**`, `apps/app/src/lib/stream-client.ts`, `apps/app/src/routes/{app-layout,home-page}.tsx` — chat.
- `e2e/experts-chat.spec.ts`, `e2e/a11y.spec.ts` e specs existentes que citavam o "Welcome".
- `.env.example`, `.docs/*.md`, `.adrs/XXXX-0019-*.md`.

## Testes

- Unitário: catálogo e prompt (limites, sem nome real, sem campo de prompt na apresentação), `ListExperts`, `SendExpertMessage` (stream, retry antes do primeiro token, sem retry depois, timeouts, abort), grafo com `FakeStreamingChatModel`, DTO, configuração, política de limite; no app: stream client, função pura de SSE, chat.
- Integração (Postgres local, sob o lock de infra): `GET /experts` (200, 401, sem prompt), envio (SSE, 400, 401, 404, 503, 429 no 21º, histórico com `system`, histórico hostil, abort propaga ao modelo, erro vira evento), sentinela em logs e spans.
- E2E: sugestão → resposta falsa → sign-out; `Stop`; erro com `Try again`; troca de expert e aviso.
- Manual: avaliação com o modelo real documentada em `QA.md` (não executada aqui: sem `OPENAI_API_KEY`).

## Riscos e rollback

- Risco: API de LangChain/LangGraph muda entre versões. Mitigação: isolada em `infrastructure`, versões no lockfile e no `ARCHITECTURE.md`.
- Risco: resposta de saúde ou jurídica lida como parecer. Mitigação: aviso, limites no prompt, avaliação em `QA.md`.
- Reverter: `git revert` do commit; não há migration nem dado persistido.

## Critério de pronto

- [x] Lint, tipos, build, testes unitários e de integração passam; E2E escrito (executado ou registrado como não executado com o motivo).
- [x] Nenhum teste chama a OpenAI; nenhum conteúdo de mensagem em log ou span.
- [x] ADR, `ARCHITECTURE.md`, `BUSINESS.md`, `QA.md`, `.env.example` atualizados.

## Perguntas abertas

| Pergunta                                                    | Impacto            | Bloqueante? | Quem decide |
| ----------------------------------------------------------- | ------------------ | ----------- | ----------- |
| Texto do aviso precisa de aprovação do Jurídico?            | Texto do aviso R7  | Não         | Jurídico    |
| Nomes dos personagens e sugestões precisam de aprovação     | Identidade expert  | Não         | Produto     |

## Histórico de execução

- 2026-11-17: fatias 1 a 5 concluídas (retomada após interrupção: corrigidos tipos do helper `readText`, testes existentes que citavam "Welcome", testes do app para SSE, stream client, estado do chat e home; E2E, docs e ADR `XXXX-0019-langgraph-como-biblioteca-na-api.md`).
