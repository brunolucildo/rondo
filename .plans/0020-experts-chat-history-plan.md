# Plano — Histórico de conversa com o expert

- **Status:** implementado (pendente: avaliação manual com o modelo real, sem `OPENAI_API_KEY`; decisão de Produto/Jurídico sobre expiração automática)
- **Slug:** 0020-experts-chat-history
- **Spec:** `.specs/0020-experts-chat-history.md`
- **Data:** 2026-11-17

## Contexto

Após a `0019` a conversa vive só na página e o cliente reenvia até 20 mensagens como `history`: recarregar ou trocar de expert perde tudo e o servidor confia num histórico forjável. Esta spec move o histórico para o Postgres (uma conversa por usuário e expert), muda o contrato do envio e adiciona leitura e exclusão.

## Objetivo

Persistir a conversa por `(usuário, expert)`; `GET /api/v1/experts/:expertId/conversation` (cursor, 50 por página); `POST .../messages` só com `{ content }` (servidor lê 20, grava pergunta e resposta, inclusive incompleta); `DELETE .../conversation`; uma resposta por vez (`409 CONVERSATION_BUSY`); retenção de 200 mensagens na mesma transação; interface com carregamento, rolagem, "Incomplete answer", erro com `Try again` e `Clear conversation` com confirmação.

## Não-objetivos

Citações (`0024`), conexões, Weaviate e arquivos (`0022` a `0025`), várias conversas por expert, título, busca, exportação, compartilhamento, exclusão de conta, resumo automático, expiração automática, carregar na interface páginas anteriores à mais recente.

## Usuários e permissões

Pessoa autenticada (`AuthGuard` global). O `user_id` vem sempre da sessão; nenhuma rota aceita `userId` do corpo, da query ou da URL. Cada pessoa só lê, envia e apaga as próprias mensagens.

## Fluxos e estados

- Feliz: abre `/app`, esqueleto, mensagens do expert selecionado, lista termina na última; envia, servidor grava, responde em streaming e grava a resposta.
- Vazio: painel de sugestões da `0019` (sem o botão `Clear conversation`).
- Carregando: esqueleto (`role="status"`), campo desabilitado, dropdown ativo; trocar de expert cancela a leitura anterior.
- Erro: "We couldn't load the conversation." + `Try again`; `409` → "This expert is still answering."; falha ao limpar → diálogo aberto com `Try again`, conversa intacta.
- Parcial: resposta `incomplete` fica gravada e reaparece com "Incomplete answer".
- Cancelamento: `Stop` grava o parcial; sem nenhum texto, a pergunta é retirada (então `Try again` não duplica); cancelar o diálogo não muda nada.

## Requisitos

R1 a R10 da spec (todos Must, exceto R10, Should).

## Contratos de dados

- Tabelas `expert_conversations` (`id`, `user_id` cascade, `expert_id`, `created_at`, única `(user_id, expert_id)`) e `expert_messages` (`id`, `conversation_id` cascade, `role`, `content`, `status`, `created_at` = `clock_timestamp()`), índice `(conversation_id, created_at, id)`; função `expert_append_message(user, expert, role, content, status, max)` retorna `(message_id, message_created_at)`.
- `GET .../conversation?limit=&before=` → `{ messages: [{ id, role, content, status, createdAt }], nextCursor }`. `limit` inteiro de 1 a 50, `before` = cursor opaco (id da mensagem mais antiga da página em base64url, validado como UUID).
- `POST .../messages` body `{ content }` (até 4.000); SSE como na `0019`; antes do primeiro byte também `409 CONVERSATION_BUSY`.
- `DELETE .../conversation` → `204`, idempotente.

## Decisões e premissas

- Decisão: gravar a resposta **antes** do último evento do stream (um `done` já implica gravada); falha ao gravar vira `failed` com razão `storage_error`.
- Decisão: quando nenhum texto chegou (falha, abort ou cliente já ausente), a pergunta recém-gravada é removida (compensação), em vez de duplicá-la no `Try again`.
- Decisão: a lista no cliente reflete só o que o servidor guarda no carregamento; `Try again` após uma resposta incompleta **com texto** envia a pergunta de novo, de modo que depois de recarregar o histórico mostra a pergunta, o parcial e a pergunta repetida com a nova resposta (é exatamente o que o modelo vê; documentado como risco).
- Decisão: `ExpertsModule` com `Pool` próprio e `CurrentSession` exportado por `modules/auth` (acréscimo mínimo ao `index.ts`).
- Decisão: confirmação de `Clear conversation` como `alertdialog` inline (sem dependência nova nem componente `Dialog` no `@repo/ui`), foco em Cancel, Escape cancela, foco volta ao botão.
- Premissa: o conteúdo da resposta do assistente não tem limite de tamanho no banco além de não ser vazio (o modelo define o tamanho).
- Premissa: a interface mostra só a página mais recente (50 mensagens); páginas anteriores ficam para o backlog (a API já as expõe).
- Premissa (Produto/Jurídico, não bloqueante): sem expiração automática; ADR `0023-conversa-persistida-dos-experts.md`.

## Abordagem (fatias verticais)

1. **Modelo de dados e repositório:** migration, `PostgresConversationRepository`, cursor, testes de unidade (cliente falso) e de integração (`42501`, unicidade, índice, retenção de 201, concorrência, cascata).
2. **API de conversa e envio persistido:** portas, `GetConversation`, `ClearConversation`, `SendExpertMessage` (janela de 20, trava, gravação, compensação), DTOs, request handlers, `409`, `history` removido; testes de unidade e de integração com duas contas.
3. **Interface:** `api-client` (`delete`, `signal`), `useConversation`, `ExpertChat` em duas camadas, `ClearConversation`, status `busy`, remoção de `buildHistory`; testes de componente.
4. **E2E, docs e ADR:** `experts-chat.spec.ts` (recarregar, trocar, incompleta, limpar, sign-out), `a11y.spec.ts`, `home.spec.ts`, `ARCHITECTURE.md`, `BUSINESS.md`, `QA.md`, ADR.

## Arquivos previstos

`db/migrations/20261117180000_create_expert_conversations.sql`; `apps/api/src/modules/experts/**` (domínio, casos de uso, repositório, trava, handlers, DTO, presenter, módulo); `apps/api/src/modules/auth/index.ts`; `apps/api/src/observability/expert-telemetry.ts` (razão `storage_error`); `apps/api/test/**`; `apps/app/src/features/experts/**`, `apps/app/src/lib/api-client.ts`, `apps/app/src/test/render-app.tsx`; `e2e/*.spec.ts`; `.docs/*.md`; `.adrs/XXXX-0020-*.md`.

## Testes

- Unitário: cursor, trava, repositório (cliente falso), `GetConversation`, `ClearConversation`, `SendExpertMessage` (janela de 20, persistência, parcial, compensação, `409`, liberação em todos os caminhos), DTOs; no app: `chat-state`, `api-client`, home.
- Integração (Postgres local, sob o lock de infra): DDL `42501`, unicidade, retenção 201 e concorrência, cascata, 120 mensagens e cursor, `limit` inválido, cursor forjado e de outro usuário, isolamento entre duas contas, janela de 20, `Stop` com parcial, `409`, liberação após desconexão, `DELETE`, sign-out, sentinela em logs e spans (inclui `GET` e `DELETE`).
- E2E: recarregar com rolagem até a última, trocar de expert, incompleta após recarregar, limpar, sign-out e sign-in; `a11y` da conversa guardada e do diálogo.
- Manual: conversar com dois experts, recarregar, trocar, limpar (`QA.md` §1.19).

## Riscos e rollback

- Dados de saúde sem expiração: exclusão pelo usuário, limite de 200 e conteúdo fora de logs; decisão de Produto/Jurídico pendente.
- Trava em memória: instância única (dívida §6 #14).
- `Try again` após parcial repete a pergunta no histórico (ver decisões).
- Reverter: `git revert` do commit e, se necessário, o rollback em comentário na migration (apaga todas as conversas).

## Critério de pronto

- [x] Lint, tipos, build, testes unitários, de integração e E2E passam (baseline conhecido: 3 falhas de `session.service.spec.ts`).
- [x] Nenhum teste chama a OpenAI; nenhum conteúdo de mensagem em log, span ou métrica (sentinela).
- [x] ADR, `ARCHITECTURE.md`, `BUSINESS.md` e `QA.md` atualizados.

## Perguntas abertas

| Pergunta                                                          | Impacto                             | Bloqueante? | Quem decide      |
| ----------------------------------------------------------------- | ----------------------------------- | ----------- | ---------------- |
| A LGPD pede expiração automática (por exemplo 90 dias)?           | Job de limpeza e texto de privacidade | Não         | Jurídico/Produto |
| Carregar páginas anteriores na interface (botão "Show earlier")?  | UX de conversas longas              | Não         | Produto          |

## Histórico de execução

- 2026-11-17: fatias 1 a 4 concluídas na execução orquestrada (`orchestrate-me 0019-0029`).
