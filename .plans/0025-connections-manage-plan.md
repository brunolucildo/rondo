# Plano — Gerenciar e excluir conexões

- **Status:** concluído (gates verdes; 3 falhas pré-existentes em `session.service.spec.ts`)
- **Slug:** 0025-connections-manage
- **Spec:** `.specs/0025-connections-manage.md`
- **Data:** 2026-11-17

## Contexto

O usuário indexa arquivos (0023) e os experts respondem com citações (0024), mas ele não vê o que indexou nem consegue remover (LGPD, dado de saúde). Esta spec fecha o ciclo de vida.

## Objetivo

Listar, excluir uma e excluir todas as conexões (vetores primeiro, linha depois, idempotente), mostrar citações de fontes excluídas como "Source removed" e oferecer o painel de conexões na interface, com confirmação.

## Não-objetivos

Upload e dedup (0023), respostas (0024), exclusão de conta, apagar conversas (0020), lixeira, desfazer, expiração, renomear, reprocessar.

## Usuários e permissões

Sessão obrigatória; `userId` só da sessão; conexão de outro usuário é `404` igual a inexistente. Nenhuma migration: `rondo_app` já tem `delete` em `connections`.

## Fluxos e estados

Listar (vazio, carregando, erro, `Try again`); excluir com diálogo (cancelar, erro 503, 409, 404 recarrega); `Delete all` com a quantidade e aviso de irreversibilidade; `processing` recusa tudo.

## Requisitos

R1 a R10 da spec, critérios sem alteração.

## Contratos de dados

- `GET /connections` -> `{ connections: ConnectionResponse[] }` (mais recente primeiro).
- `DELETE /connections/:id` -> `204 | 400 VALIDATION_FAILED | 404 CONNECTION_NOT_FOUND | 409 CONNECTION_PROCESSING | 503 KNOWLEDGE_UNAVAILABLE`.
- `DELETE /connections` -> `204 | 409 | 503`.
- `GET /experts/:id/conversation`: cada citação ganha `removed` e, quando `true`, `sourceName` é `null` (o servidor nunca devolve o nome de uma fonte excluída). O que está guardado na mensagem não muda.

## Integrações

`KnowledgeIndex.deleteByConnection` e `deleteAllForUser` (0022) pelo barrel do `knowledge`; `KnowledgeIndexUnavailableError` vira `ConnectionIndexUnavailableError` no domínio e `503 KNOWLEDGE_UNAVAILABLE` na interface.

## Decisões e premissas

- Decisão: ordem vetores -> linha; a linha só some com `delete ... where not (processing recente)`, então um reenvio que reivindicou o `failed` no meio da exclusão não perde a linha (resposta `409`).
- Decisão: uma `processing` com mais de 15 minutos (regra da 0023) pode ser excluída.
- Decisão: a resolução de citações fica no caso de uso `GetConversation` (porta `ConnectionSources.existingIds`), não no repositório de conversas.
- Decisão: o painel é um botão "Your connections" ao lado de "Add connection"; o painel tem as seções "Add" e "Your connections".
- Premissa: sem rate limit novo (a exclusão é por usuário autenticado e idempotente).
- Premissa: depois de excluir no painel, as citações já na tela passam a "Source removed" na hora (estado local) e na próxima leitura da conversa (servidor).

## Abordagem (fatias verticais)

1. API de conexões: portas, casos de uso, repositórios (Postgres e memória), handlers, telemetria, testes unitários.
2. Citações removidas no `GET conversation`.
3. Painel de conexões na interface e testes de componente.
4. Integração (Postgres e Weaviate locais), E2E, documentação, ADR e gates.

## Arquivos previstos

`apps/api/src/modules/connections/**`, `apps/api/src/modules/experts/**` (aditivo), `apps/api/src/observability/connection-telemetry.ts`, `apps/app/src/features/connections/**`, `apps/app/src/features/experts/answer-sources.tsx`, testes, `.docs/{ARCHITECTURE,BUSINESS,QA}.md`, ADR provisório.

## Testes

- Unitário: ordem e idempotência, 409, 404, 503, telemetria sem sentinela.
- Integração: isolamento entre dois usuários, falha do índice, 409, reuso após exclusão, exclusão total, citação removida, Weaviate real.
- E2E: listar, excluir, cancelar, `Delete all`.
- Manual: `.docs/QA.md`.

## Riscos e rollback

Exclusão irreversível: diálogo de confirmação, ordem segura. Rollback: reverter o commit (sem migration).

## Critério de pronto

- [x] Gates lint, types, build, test, integração e E2E (baseline conhecido à parte).

## Perguntas abertas

Ver a spec §11 (não bloqueantes).
