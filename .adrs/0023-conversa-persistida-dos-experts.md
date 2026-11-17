# 0023 — Conversa persistida dos experts: uma conversa por (usuário, expert), retenção de 200 mensagens e trava em memória

- **Status:** aceito (decisão da spec `0020`)
- **Data:** 2026-11-17
- **Spec:** `.specs/0020-experts-chat-history.md`

## Contexto

Até a spec `0019` a conversa com um expert vivia só na página e o cliente reenviava até 20 mensagens como `history`. Recarregar, trocar de expert ou entrar em outro dispositivo perdia tudo, e o servidor confiava num histórico que o cliente podia forjar. As conversas com os experts de saúde podem conter dados de saúde de atletas (dado pessoal sensível, LGPD). O banco é o Postgres nativo acessado por `pg` com o role `rondo_app` sem DDL (ADR `0015`); a API roda em instância única (ADR `0005`).

## Decisão

1. **Modelo de dados (migration `20261117180000_create_expert_conversations.sql`):** `expert_conversations` (`id`, `user_id` com `on delete cascade`, `expert_id`, `created_at`, **unique** `(user_id, expert_id)`) e `expert_messages` (`id`, `conversation_id` com `on delete cascade`, `role` `user`/`assistant`, `content`, `status` `complete`/`incomplete`, `created_at` com `clock_timestamp()`), índice `(conversation_id, created_at, id)`. `rondo_app` recebe só DML e `execute` na função; criar, alterar ou apagar tabela falha com `42501`. Uma conversa por par, sem título, busca nem várias conversas por expert.
2. **O servidor é dono do histórico.** `POST /experts/:expertId/messages` recebe só `{ content }` (um corpo com `history` é `400 VALIDATION_FAILED`, sem campo "por compatibilidade"). O caso de uso lê as últimas 20 mensagens, grava a pergunta, envia ao modelo persona + 20 + nova e grava a resposta **antes** do último evento do stream (`done`/`error`), de modo que recarregar logo após o `done` já a encontra. O `user_id` vem sempre da sessão.
3. **Resposta incompleta é dado:** `Stop`, queda da conexão ou falha do modelo depois do primeiro token gravam o texto recebido com `status = incomplete`; as incompletas entram no contexto do modelo como estão. Se **nenhum texto** chegou, a pergunta recém-gravada é retirada (compensação), para que `Try again` não deixe a mesma pergunta duas vezes na conversa.
4. **Retenção:** no máximo 200 mensagens por conversa, sem expiração automática (a pergunta jurídica de 90 dias segue aberta com Produto/Jurídico). A gravação é a função SQL `expert_append_message` (cria a conversa se preciso, insere e remove as mais antigas **na mesma transação**; o `on conflict ... do update` trava a linha da conversa e serializa gravações concorrentes). Excluir: `DELETE /experts/:expertId/conversation` (idempotente, `204`), com confirmação na interface. Sign-out, sign-in e reset de senha não tocam a conversa.
5. **Paginação:** `GET /experts/:expertId/conversation?limit=&before=` devolve até 50 mensagens em ordem cronológica e `nextCursor`. O cursor é opaco para o cliente (id da mensagem mais antiga da página em base64url), validado como UUID e usado só como parâmetro ligado, restrito à conversa da sessão.
6. **Uma resposta por vez por (usuário, expert):** porta `ConversationLock` com implementação **em memória** (`InMemoryConversationLock`). Segunda tentativa recebe `409 CONVERSATION_BUSY` antes do primeiro byte. A trava é liberada ao terminar o stream (`finally` do gerador que também grava a resposta) e, de novo e de forma idempotente, no `finally` do request handler; o `close` da conexão aborta a resposta mesmo antes do primeiro `await`.
7. **Privacidade na telemetria:** conteúdo de mensagem nunca vai a log, span ou métrica. O acesso ao banco passa pelo `DatabaseClient` instrumentado, que não lê o SQL; os erros de armazenamento (`ConversationStorageError`) têm mensagem fixa com a operação e o SQLSTATE. Falha ao gravar a resposta vira `failed` com razão fechada `storage_error`.
8. **Código:** portas `ConversationRepository` e `ConversationLock` em `domain`; `PostgresConversationRepository` e `InMemoryConversationLock` em `infrastructure`; casos de uso `GetConversation`, `ClearConversation` e `SendExpertMessage` (alterado) em `application`; um request handler por endpoint (ADR `0014`). `ExpertsModule` tem seu próprio `Pool` (a fatia não depende do módulo de auth para o banco) e lê a sessão pelo `CurrentSession` exportado por `modules/auth`.

## Alternativas consideradas

| Alternativa | Prós | Contras | Por que não |
| ----------- | ---- | ------- | ----------- |
| Manter `history` no cliente e só guardar uma cópia | Mudança pequena | O servidor continua confiando num histórico forjável; a cópia diverge | O objetivo é o servidor ser a fonte do contexto |
| Checkpointer do LangGraph no Postgres | Reaproveita o grafo | Cria tabelas em runtime (DDL com role de aplicação) e acopla o histórico ao grafo | Proibido pela spec e pelo ADR `0015`; toda tabela nasce por migration |
| Retenção por job de limpeza | Sem custo na gravação | Pico acima do limite entre execuções; peça operacional nova | A função SQL dá o limite exato e é atômica |
| Trava por `pg_advisory_lock` | Vale para várias instâncias | A trava ficaria presa a uma conexão do pool durante o stream inteiro (minutos) | Instância única hoje (ADR `0005`); a porta permite trocar por um armazenamento compartilhado |
| Gravar a resposta só no `finally` após o stream | Menos código | O cliente pode ler `done` e recarregar antes da gravação | A gravação antes do último evento garante leitura após `done` |

## Consequências

- Positivas: a conversa persiste entre recargas, trocas de expert e dispositivos; o contexto do modelo não pode ser forjado pelo cliente; limite de armazenamento e exclusão pelo usuário garantidos; isolamento por `user_id` da sessão em toda consulta.
- Negativas: dados de saúde ficam guardados (sem expiração automática até a decisão de Produto/Jurídico); a trava em memória só vale para uma instância da API (documentado em `ARCHITECTURE.md` §6); a gravação da resposta acrescenta uma ida ao banco antes do último evento do stream; um segundo `Pool` do `pg` (10 conexões) na API.
- Impacto: cliente e API mudam juntos (contrato do `POST`); a spec `0024` guardará as citações por uma migration que acrescenta uma coluna em `expert_messages`; a exclusão em cascata da conta continua dependendo do `on delete cascade` de `user_id`.
