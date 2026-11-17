# Plano — Fundação do conhecimento: Weaviate local e embeddings

- **Status:** concluído (gates verdes; `infra:reset` real não rodado; 3 falhas pré-existentes em `session.service.spec.ts`)
- **Slug:** 0022-rag-weaviate-foundation
- **Spec:** `.specs/0022-rag-weaviate-foundation.md`
- **Data:** 2026-11-17

## Contexto

Três specs (0023, 0024, 0025) e as da fase 2 precisam do mesmo índice vetorial. Esta spec entrega só a infra (Weaviate no Compose), o contrato (`KnowledgeIndex`, `EmbeddingsGenerator`), os adaptadores e a prova de isolamento por usuário. Não há consumidor ainda: o `KnowledgeModule` existe, mas não é importado pelo `AppModule` (as specs 0023/0024 o fazem).

## Objetivo

`bun run infra:up` sobe o Weaviate saudável (só 127.0.0.1, só com chave de API); a API grava e busca chunks por usuário, um tenant por usuário, sem vazar entre usuários, com timeout, retry e erros tipados, sem texto, vetor ou tenant em log, span ou métrica.

## Não-objetivos

Upload, chunking, dedup (0023); busca no chat e citações (0024); telas e exclusão LGPD completa (0025); LangSmith; busca híbrida, reranking, módulos vetorizadores, backup, HA.

## Usuários e permissões

Isolamento estrutural: tenant do Weaviate por usuário (`u_<uuid sem hífens>`). `userId` vem sempre da sessão (responsabilidade do consumidor). Nenhuma busca atravessa tenants; tenant inexistente devolve `[]` sem criar.

## Fluxos e estados

Feliz: `upsert` cria o tenant sob demanda e grava; `search` por vetor devolve os mais próximos do tenant. Vazio: tenant inexistente ou sem chunks → `[]`. Erro: Weaviate fora/lento/chave errada → `KnowledgeIndexUnavailableError`; OpenAI 429/5xx → retry e `EmbeddingsUnavailableError`. Retry: operações idempotentes (id estável por chunk).

## Requisitos

R1 a R9 da spec (ver o arquivo da spec; os critérios de aceite valem sem alteração).

## Contratos de dados

Coleção `KnowledgeChunk` (multi-tenancy ligada, vetor fornecido pela aplicação, cosseno, 1.536 dimensões, `description` registra modelo e dimensão). Propriedades: `connectionId`, `sourceName`, `position`, `page`, `text`. Id do objeto: UUID v5 de `connectionId:position` (upsert idempotente). Sem PII além do conteúdo do próprio documento.

## Integrações

Weaviate 1.40.5 por HTTP 8080 e gRPC 50051 (`weaviate-client` 3.15.3, `@langchain/weaviate` 1.1.0); timeout 10 s por tentativa, 3 tentativas (250 ms e 500 ms) só para falha de indisponibilidade. OpenAI embeddings (`@langchain/openai`): lote de 96, timeout 20 s, 3 tentativas em 429/5xx, sem chave falha sem rede.

## Decisões e premissas

- Decisão: tenant por usuário (não filtro), vetores calculados pela aplicação, `API_BASED_MODULES_DISABLED=true` (a imagem 1.40 liga 45 módulos de provedores por padrão).
- Decisão: leitura pelo `WeaviateStore` do LangChain; escrita, tenants e remoção pelo client oficial (o `addVectors` do LangChain faz `console.log/error` do payload e o `delete` não devolve a contagem, o que impede a remoção em laço).
- Premissa: `KnowledgeModule` não entra no `AppModule` nesta spec (sem consumidor); `WEAVIATE_URL`/`WEAVIATE_API_KEY` só são exigidas quando o módulo é carregado.
- Premissa: os testes de integração exigem o Weaviate só no `beforeAll` dos testes do módulo `knowledge`, não no `globalSetup`.

## Abordagem (fatias verticais)

1. **Infra:** serviço `weaviate` no Compose, `infra-up/down/reset`, `.env.example`. Verificação: `docker compose config`, container saudável, 401 sem chave.
2. **Contrato + embeddings:** domínio (`KnowledgeIndex`, `EmbeddingsGenerator`, regras, erros), fakes em memória, adaptador OpenAI com lote/timeout/retry; testes de unidade e de fronteira.
3. **Adaptador Weaviate:** coleção, tenants, upsert, busca, delete, erros tipados, retry e telemetria; testes de integração (isolamento, delete, idempotência, tenant inexistente, Weaviate parado, sentinela).
4. **Docs e gates:** `ARCHITECTURE.md`, `QA.md`, ADR, lint, tipos, build, testes.

## Arquivos previstos

`docker-compose.yml`, `scripts/infra-*.ts`, `.env.example`, `apps/api/src/modules/knowledge/**`, `apps/api/src/observability/knowledge-telemetry.ts`, `apps/api/test/knowledge-*.int-spec.ts`, `.docs/ARCHITECTURE.md`, `.docs/QA.md`, `.adrs/0020-weaviate-com-multi-tenancy-por-usuario.md`.

## Testes

- Unitário: lotes, retry, erros, regras (tenant, validação), fronteira de domínio, fakes, telemetria.
- Integração: Weaviate local real (isolamento de dois usuários, delete, idempotência, tenant inexistente, parado, sentinela).
- E2E: não aplicável (sem UI nem endpoint).
- Manual: `docker compose config`, `infra:up`, 401 sem chave, `infra:reset`.

## Riscos e rollback

- Risco: vazamento entre usuários (mitigado por tenant + teste); mudança de API do client (versões fixadas, adaptador isolado); limite de tenants por nó (aceito local, registrado no ADR).
- Reverter: remover o serviço e o volume do Compose e o módulo; nenhuma migration.

## Critério de pronto

- [x] Gates `lint`, `check-types`, `build`, `test:integration` passam (Weaviate local); `test` só com as 3 falhas pré-existentes de `session.service.spec.ts`.
- [x] ADR e docs atualizados.
- [ ] Commit e push feitos.

## Perguntas abertas

| Pergunta | Impacto | Bloqueante? | Quem decide |
| -------- | ------- | ----------- | ----------- |
| Backup do Weaviate em deploy | Dívida de infra | Não | Eng./Produto |
