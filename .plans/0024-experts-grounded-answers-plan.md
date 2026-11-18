# Plano — Respostas dos experts ancoradas nas fontes, com citações

- **Status:** concluído (gates verdes; 3 falhas pré-existentes em `session.service.spec.ts`; avaliação com o modelo real e calibração do limiar pendentes)
- **Slug:** 0024-experts-grounded-answers
- **Spec:** `.specs/0024-experts-grounded-answers.md`
- **Data:** 2026-11-17

## Contexto

O chat (0019, 0020) responde só com o conhecimento do modelo, e o índice vetorial por usuário (0022) já recebe os documentos conectados (0023). Falta ligar os dois: recuperar trechos na hora da pergunta, passá-los ao modelo como dado, devolver citações montadas pelo servidor e declarar a lacuna quando nenhuma fonte cobre a pergunta (`BUSINESS.md` §10).

## Objetivo

Cada mensagem passa por um nó de recuperação no grafo LangGraph; a resposta traz citações guardadas com a mensagem; sem fonte relevante o expert diz isso; falha da busca vira `KNOWLEDGE_UNAVAILABLE`, nunca resposta silenciosa sem fonte.

## Não-objetivos

Ingestão (0022, 0023); gestão e exclusão de conexões (0025); busca híbrida, reranking, reescrita de pergunta, agentes com ferramentas e avaliação offline; abrir o arquivo original.

## Usuários e permissões

Sessão obrigatória. `userId` vem da sessão; `connectionIds` são conferidos contra o dono e o estado `ready` (`404 CONNECTION_NOT_FOUND`, `409 CONNECTION_NOT_READY`). O índice só é consultado no tenant do usuário.

## Fluxos e estados

Feliz: anexo `ready` (ou sem anexo) → pergunta → embedding da pergunta e busca → contexto delimitado → streaming → evento `citations` → `done`. Vazio: sem conexão `ready`, sem busca e sem aviso. Lacuna: nenhum trecho acima do limiar → declaração do modelo, `citations: []` e aviso na interface. Erro: `KNOWLEDGE_UNAVAILABLE` com `Try again`. Parcial: o texto parcial é guardado com as citações já recuperadas.

## Requisitos

R1 a R10 da spec; os critérios de aceite valem sem alteração.

## Contratos de dados

- `expert_messages.citations jsonb null` (migration nova): `null` = nenhuma recuperação rodou (pergunta do usuário, usuário sem conexões, mensagens anteriores à 0024); `[]` = recuperação rodou e nenhuma fonte cobre a pergunta (lacuna); lista não vazia = fontes usadas. Cada item: `connectionId`, `sourceName`, `page` (ou `null`) e `position`. Nunca o texto do trecho.
- `expert_append_message` ganha o parâmetro `p_citations jsonb default null` (a função antiga é removida; chamadas com 6 argumentos continuam válidas).
- SSE: eventos `delta`, `citations` (`{ citations }`, uma vez, antes de `done`, só quando a recuperação rodou), `done` e `error` (`EXPERT_ANSWER_FAILED` ou `KNOWLEDGE_UNAVAILABLE`).
- `GET /experts/:expertId/conversation`: cada mensagem ganha `citations` (`null` ou lista).

## Integrações

`EmbeddingsGenerator` e `KnowledgeIndex` (módulo `knowledge`, só pelo barrel) por trás da porta `KnowledgeRetriever` do experts; `ConnectionRepository` (módulo `connections`, pelo barrel) por trás da porta `ConnectionSources`. Falha de embeddings ou do índice vira `ExpertKnowledgeUnavailableError` (os adaptadores da 0022 já fazem retry com timeout).

## Decisões e premissas

- Decisão: a recuperação é um nó do grafo (`START → retrieve → respond → END`) e emite o evento interno `citations` assim que termina; o caso de uso guarda esse valor, grava com a mensagem e o repassa ao stream logo antes de `done`.
- Decisão: `citations` nulo versus lista vazia distingue "sem recuperação" de "lacuna" sem coluna extra; a interface só mostra o aviso para lista vazia.
- Decisão: o texto dos trechos vai ao modelo dentro de `<retrieved_context>` com `&`, `<` e `>` escapados (o trecho não consegue fechar o bloco); o prompt de sistema diz que o bloco é dado, nunca instrução, e que o modelo não escreve citações.
- Decisão: R8 manda manter a mensagem do usuário quando a busca falha. Para o `Try again` não duplicar a pergunta, o caso de uso reaproveita a última mensagem do usuário sem resposta quando o texto enviado é igual.
- Decisão: a verificação de posse e estado dos `connectionIds` e a checagem "há conexão `ready`" acontecem antes de abrir o stream e antes do lock.
- Premissa: limiar inicial de similaridade 0,30 (`EXPERT_RETRIEVAL_MIN_SCORE`) e 6 trechos (`EXPERT_RETRIEVAL_MAX_CHUNKS`, no máximo 12); a calibração com o modelo real fica em `QA.md`.
- Premissa: o E2E usa o modelo e os embeddings falsos; a pergunta igual ao texto do trecho é o que gera similaridade alta com o gerador falso (ele não tem semântica).
- Dúvida em aberto (não bloqueante): mostrar o trecho exato ao clicar na fonte (Produto).

## Abordagem (fatias verticais)

1. Dados e domínio: migration, regras de citação e prompt ancorado, configuração do limiar, persistência e `GET conversation` com citações.
2. Recuperação: nó no grafo, adaptador sobre os ports do `knowledge`, `connectionIds` (DTO, posse, estado, escopo), evento `citations` no stream, `KNOWLEDGE_UNAVAILABLE`, telemetria sem conteúdo.
3. Interface: `connectionIds` do anexo, seção "Sources", aviso de lacuna, estados de erro, histórico com citações.
4. Testes de integração (escopo, dedup, lacuna, falha do índice, isolamento, injeção, sentinela), E2E, documentação, ADR e gates.

## Arquivos previstos

`db/migrations/*_add_expert_message_citations.sql`; `apps/api/src/modules/experts/**` (domínio, caso de uso, grafo, adaptadores, DTO, handler, SSE, presenter); `apps/api/src/modules/connections/{index.ts,connections.module.ts,domain/connection-ports.ts,infrastructure/postgres-connection.repository.ts,testing/in-memory-connection.repository.ts}` (export e consulta `ready`, aditivos); `apps/api/src/config/environment.ts`; `apps/api/src/observability/expert-telemetry.ts`; `apps/api/test/*`; `apps/app/src/features/{experts,connections}/**`; `e2e/experts-grounded-answers.spec.ts`; `.env.example`; `.docs/*`; `.adrs/0025-recuperacao-e-citacoes-do-servidor.md`.

## Testes

- Unitário: citações (dedup, ordem, posição), prompt (delimitação, escape, lacuna), configuração, grafo com modelo falso que registra o prompt, caso de uso (escopo, erros, citações, parcial, falha), SSE, DTO, repositório.
- Integração: migration e função, persistência e leitura de citações, escopo de busca com Weaviate local, dedup sem novo embedding, lacuna, falha do índice, isolamento entre usuários, trecho malicioso, sentinela em log, span e métrica.
- E2E: anexar, perguntar, ver fontes, recarregar; lacuna; sem conexões.
- Manual: ver `QA.md` (modelo real não executado nesta entrega).

## Riscos e rollback

- Risco: limiar mal calibrado; mitigação: configurável por ambiente.
- Risco: injeção por documento; mitigação: bloco delimitado com escape, regra no prompt, citações do servidor.
- Como reverter: a migration traz o rollback no comentário; sem a coluna o código antigo da 0020 continua válido.

## Critério de pronto

- [x] R1 a R10 atendidos e cobertos por teste.
- [x] `lint`, `check-types`, `build`, `test`, `test:integration` e `test:e2e` sem chamar a OpenAI (o `test` do api tem as 3 falhas de baseline).
- [x] `ARCHITECTURE.md`, `BUSINESS.md` e `QA.md` atualizados; ADR registrado (`.adrs/0025-recuperacao-e-citacoes-do-servidor.md`).

## Perguntas abertas

| Pergunta                                          | Impacto                | Bloqueante? | Quem decide |
| ------------------------------------------------- | ---------------------- | ----------- | ----------- |
| Mostrar o trecho exato ao clicar na fonte?        | Interface e leitura do índice | Não  | Produto     |
