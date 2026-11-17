# 0020 — Histórico de conversa com o expert

> Spec executável. Preencha todas as seções; `TODO` é lacuna, não requisito.
> Use `create-spec` para criar, `refine-spec` para auditar e `implement-me` para executar.

- **Status:** pronta
- **Slug:** 0020-experts-chat-history
- **Data:** 2026-11-17
- **Atualizado em:** 2026-11-17
- **Owner:** Produto (retenção e textos); Time de engenharia (execução)
- **Relacionados:** mapa `.plans/experts-breakdown.md`; `.docs/BUSINESS.md` §7 ("Histórico de demandas e entregas") e §9 item 6 (retenção e LGPD); `.docs/ARCHITECTURE.md` §4.6 (banco, `rondo_app` sem DDL) e §6; ADR `0015` (Postgres nativo), `0014`. **Depende de:** 0019 (chat e contrato de mensagens). **Destrava:** 0024 (guarda as citações nas mensagens).

## 1. Escopo

### Dentro do escopo

- **Uma conversa por par (usuário, expert)**, persistida no Postgres: ao reabrir `/app`, a conversa do expert selecionado reaparece.
- `GET /api/v1/experts/:expertId/conversation`: devolve as mensagens guardadas (ordem cronológica, paginação por cursor).
- **Mudança de contrato do envio:** `POST /api/v1/experts/:expertId/messages` passa a receber só `{ content }`; o servidor lê o histórico do banco, grava a mensagem do usuário e a resposta (inclusive a **incompleta**) e envia ao modelo as últimas 20 mensagens. O campo `history` da 0019 deixa de existir.
- `DELETE /api/v1/experts/:expertId/conversation`: **"Clear conversation"**, com confirmação na interface; apaga todas as mensagens daquele par.
- Migration em `db/migrations/` (tabelas de conversa e mensagem, índices, `grant` ao `rondo_app` só com DML) e regras de retenção.
- Estados de interface: carregando o histórico, vazio (sugestões da 0019), erro ao carregar com `Try again`, e rolagem até a última mensagem.
- Atualização de `ARCHITECTURE.md`, `BUSINESS.md` (retenção) e `QA.md`.

### Fora do escopo

- Chat, streaming, sugestões e avatar-fallback: **0019** (esta spec só muda o contrato do envio).
- Citações nas respostas e a coluna que as guarda: **0024** (a 0020 deixa as mensagens prontas para receber essa coluna por migration futura).
- Conexões, arquivos, Weaviate e dedup: **0022** a **0025**.
- Várias conversas por expert, títulos, busca no histórico, exportação, compartilhamento: backlog.
- Exclusão da conta do usuário e remoção em cascata de toda a conta: backlog (não existe hoje).
- Resumo automático de conversas longas e memória de longo prazo do agente: backlog.

## 2. Contexto

**Estado atual (após a 0019).** A conversa vive só na memória da página e o cliente reenvia até 20 mensagens como `history`. Recarregar, trocar de expert ou entrar em outro dispositivo perde tudo, e o servidor confia num histórico que o cliente pode forjar.

**Por que agora.** `BUSINESS.md` §7 prevê "Histórico de demandas e entregas" e §6 prevê que o usuário "refine a demanda". Sem histórico não há refinamento entre sessões. Mover o histórico para o servidor também elimina o histórico forjado e prepara as citações da 0024. É uma capacidade própria, com dados pessoais e retenção, por isso não entra na 0019.

**Dados sensíveis.** As conversas com os experts de saúde podem conter dados de saúde de atletas (dado pessoal sensível, LGPD). Por isso a spec define retenção, exclusão e proíbe o conteúdo em logs.

## 3. Necessidade de negócio

| Item                     | Descrição                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Usuário/papel afetado    | Pessoa autenticada; cada pessoa só enxerga as próprias conversas.                                                  |
| Decisão ou ação que muda | Continuar uma análise no dia seguinte, em outro navegador, sem repetir contexto; apagar a conversa quando quiser. |
| Resultado esperado       | A conversa de cada expert persiste e reaparece; o usuário controla a exclusão.                                     |
| Métrica de sucesso       | % de sessões que reabrem uma conversa existente; conversas por usuário por semana; 0 vazamentos entre usuários.   |

## 4. Requisitos

| ID  | Requisito                                                                                                                                                                                                                                                                                           | Prioridade | Critério de aceite                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Modelo de dados: conversa única por `(user_id, expert_id)` e mensagens `(id, conversation_id, role, content, status, created_at)` com `role` `user`/`assistant` e `status` `complete`/`incomplete`; `on delete cascade` do usuário; `rondo_app` só com DML; funções SQL só se houver atomicidade a garantir. | Must       | Given a migration aplicada, Then `rondo_app` consegue `insert`/`select`/`delete` nas tabelas e falha em `create`/`alter`/`drop` com SQLSTATE `42501`; há índice por `(conversation_id, created_at)` e unicidade de `(user_id, expert_id)`.                                              |
| R2  | `GET /api/v1/experts/:expertId/conversation?limit=&before=` devolve as mensagens do **usuário da sessão** em ordem cronológica, no máximo 50 por página (padrão 50; `limit` fora de 1 a 50 ou não inteiro → `400 VALIDATION_FAILED`; `before` é um cursor opaco devolvido em `nextCursor`), com `nextCursor` para as mais antigas. Sem conversa devolve lista vazia.                                                       | Must       | Given 120 mensagens, When pede sem parâmetros, Then recebe as 50 mais recentes em ordem cronológica e um `nextCursor`; When pede com o cursor, Then recebe as 50 anteriores. Given nenhum histórico, Then `200` com `messages: []`. Given expert inexistente, Then `404 EXPERT_NOT_FOUND`. |
| R3  | Isolamento: nenhuma rota devolve ou altera mensagens de outro usuário; o `user_id` vem sempre da sessão.                                                                                                                                                                                            | Must       | Given dois usuários com conversas no mesmo expert, When o usuário B lê, envia e apaga, Then só vê e altera as próprias mensagens (teste de integração com duas contas); `expertId` e `before` são validados e nunca interpolados em SQL.                                                  |
| R4  | `POST /api/v1/experts/:expertId/messages` recebe só `{ content }` (até 4.000 caracteres). O servidor grava a mensagem do usuário, envia ao modelo as últimas 20 mensagens (respostas `incomplete` entram como estão), faz o streaming e grava a resposta ao terminar; se o stream for interrompido, grava o texto parcial com `status: incomplete`. | Must       | Given uma conversa com 30 mensagens, When envia uma nova, Then o modelo falso recebe a persona e exatamente as 20 últimas mensagens mais a nova; When termina, Then a resposta está no banco como `complete`. Given `Stop` no meio, Then fica gravada como `incomplete` com o texto parcial. |
| R5  | O campo `history` do contrato da 0019 é removido; um corpo com `history` é rejeitado.                                                                                                                                                                                                              | Must       | Given `{ content, history }`, When envia, Then `400 VALIDATION_FAILED`; o cliente da 0019 deixa de enviar `history`.                                                                                                                                                                   |
| R6  | Uma resposta por vez por `(user, expert)`: enquanto uma resposta está sendo gerada, outro envio para o mesmo par recebe `409 CONVERSATION_BUSY`; a trava é liberada ao terminar, abortar ou falhar (inclusive se o cliente desconectar).                                                            | Must       | Given uma resposta em curso, When outro envio chega para o mesmo par, Then `409 CONVERSATION_BUSY`; Given o stream cancelado, When envia de novo logo depois, Then é aceito. Given outro expert, Then não é bloqueado.                                                                  |
| R7  | `DELETE /api/v1/experts/:expertId/conversation` apaga todas as mensagens e a conversa do par, é idempotente e responde `204`; a interface pede confirmação e depois mostra o estado vazio. Falha de rede ou 5xx mantém a conversa visível e oferece `Try again`.                                     | Must       | Given uma conversa, When clica em `Clear conversation` e confirma, Then `204`, a lista some e uma recarga mostra o estado vazio; When cancela a confirmação, Then nada muda. Given nenhuma conversa, When `DELETE`, Then `204`.                                                          |
| R8  | Retenção: as mensagens ficam até o usuário limpar a conversa; cada conversa guarda no máximo 200 mensagens e, ao gravar a 201ª, a mais antiga é removida **na mesma transação** da gravação (função SQL, pois exige atomicidade). Conteúdo de mensagens nunca vai para logs, spans ou métricas.                                                                              | Must       | Given uma conversa com 200 mensagens, When grava mais uma, Then a mais antiga some e o total continua 200. Given valor sentinela no conteúdo, Then não aparece em log, span ou métrica (teste de observabilidade).                                                                       |
| R9  | Interface: ao abrir `/app` ou trocar de expert, carrega a conversa daquele expert (carregando → mensagens ou estado vazio com sugestões); rola até a última mensagem; mostra o aviso "Incomplete answer" nas respostas incompletas; erro ao carregar mostra `Try again`.                              | Must       | Given uma conversa guardada, When recarrega a página, Then as mensagens aparecem na mesma ordem e a lista termina na última; When troca de expert, Then vê a conversa do outro expert. Given falha ao carregar, Then "We couldn't load the conversation." e `Try again`.              |
| R10 | Sign-out e novo sign-in **não** apagam a conversa; reset de senha não a afeta.                                                                                                                                                                                                                      | Should     | Given um usuário com conversa, When faz sign-out e sign-in, Then a conversa continua lá.                                                                                                                                                                                              |

## 5. Fluxos e estados

- **Caminho feliz:** o usuário abre `/app`; a interface busca a conversa do expert; as mensagens aparecem e a lista termina na última; ele envia uma nova mensagem; o servidor grava, responde em streaming e grava a resposta.
- **Vazio:** sem conversa, aparece o painel de sugestões da 0019.
- **Carregando:** esqueleto da lista enquanto busca; trocar de expert mostra o esqueleto e cancela a busca anterior.
- **Erro:** falha ao carregar → mensagem com `Try again`; `409 CONVERSATION_BUSY` → "This expert is still answering."; falha ao limpar → `Try again`, conversa intacta; 401 → `/auth/sign-in`.
- **Sucesso parcial:** resposta incompleta fica gravada e marcada; o usuário vê "Incomplete answer" ao recarregar.
- **Cancelamento/retry:** `Stop` grava o parcial; `Clear conversation` pede confirmação; cancelar a confirmação não altera nada; `Try again` reenvia a última pergunta sem duplicar o balão do usuário.

## 6. Acceptance Criteria

- [ ] Given a migration, Then `rondo_app` tem DML e não tem DDL (`42501`), e `(user_id, expert_id)` é único.
- [ ] Given 120 mensagens, Then `GET` devolve 50, em ordem cronológica, e o cursor traz as 50 anteriores.
- [ ] Given dois usuários, Then cada um só lê, envia e apaga as próprias mensagens.
- [ ] Given 30 mensagens, Then o modelo recebe a persona e as 20 últimas mais a nova, e a resposta é gravada.
- [ ] Given `Stop`, Then a resposta fica `incomplete` com o texto parcial.
- [ ] Given `{ content, history }`, Then `400 VALIDATION_FAILED`.
- [ ] Given uma resposta em curso, Then outro envio do mesmo par recebe `409 CONVERSATION_BUSY`; outro expert não é bloqueado.
- [ ] Given `Clear conversation` confirmado, Then `204` e o estado vazio persiste após recarregar; sem confirmar, nada muda.
- [ ] Given 201 mensagens, Then a mais antiga é removida e o total fica 200.
- [ ] Given o sentinela, Then nenhum log, span ou métrica o contém.
- [ ] Given recarregar a página e trocar de expert, Then cada conversa reaparece na ordem certa.
- [ ] Given `bun run lint`, `check-types`, `test`, `test:integration` e `test:e2e`, Then passam.

## 7. O que fazer

1. Escrever a migration (tabelas, índices, `grant` DML ao `rondo_app`, rollback no comentário) e rodar `bun run db:migrate`.
2. Adicionar à fatia `modules/experts`: portas `ConversationRepository` e `ConversationLock`, repositório Postgres (via `DatabaseClient`, com a `operation` declarada), casos de uso `GetConversation`, `ClearConversation` e a mudança em `SendExpertMessage`, e os request handlers `GetConversation` e `ClearConversation`.
3. Ajustar o DTO do envio (remove `history`, mantém `content`) e a montagem das mensagens do modelo (persona + últimas 20).
4. Implementar a trava por `(user, expert)` com liberação garantida em todos os caminhos de saída.
5. Aplicar a retenção de 200 mensagens na gravação.
6. Atualizar a interface: carregamento da conversa, rolagem, "Incomplete answer", `Clear conversation` com diálogo de confirmação e remoção de `history` do cliente.
7. Escrever os testes: unidade (regras de retenção e janela de 20), integração (isolamento entre dois usuários, `409`, parcial, limpeza, `42501`), componente e E2E (recarregar, trocar de expert, limpar).
8. Atualizar `ARCHITECTURE.md` (novas tabelas e rotas), `BUSINESS.md` (retenção) e `QA.md`, e registrar o ADR do modelo de conversa (tabelas, retenção de 200 mensagens e trava em memória), conforme `RULES.md` §5.

## 8. O que não fazer

- Não aceitar `userId` do corpo ou da URL; ele vem da sessão.
- Não registrar conteúdo, prompt ou `expertId` junto com conteúdo em logs, spans ou métricas.
- Não criar DDL em runtime (nada de `setup()` de checkpointer com role de aplicação): toda tabela nasce por migration com o `rondo_migrator`.
- Não implementar várias conversas por expert, busca, exportação ou resumo automático.
- Não apagar a conversa em sign-out, sign-in ou reset de senha.
- Não manter o campo `history` "por compatibilidade".
- Não tocar em citações, conexões ou Weaviate (0022 a 0025).

## 9. Riscos e dependências

| Tipo        | Descrição                                                                                                       | Mitigação                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Dependência | 0019 (contrato `POST` com `history`, persona e janela de mensagens).                                            | Implementar depois dela; a mudança de contrato é a primeira tarefa.                                                             |
| Risco       | Dados de saúde de atletas guardados sem prazo de expiração.                                                     | Exclusão pelo usuário (R7), limite de 200 mensagens (R8), conteúdo fora de logs; Produto decide uma expiração automática (§11). |
| Risco       | A trava em memória só vale para uma instância da API.                                                           | Aceito (instância única, como o limite de requisições, ADR `0005`); documentar em `ARCHITECTURE.md` §6.                         |
| Risco       | Trava presa se o cliente desconectar no meio do stream.                                                         | Liberar a trava em `finally` e no evento de fechamento da conexão; teste de desconexão.                                         |
| Risco       | Mudar o contrato quebra o cliente da 0019 e testes existentes.                                                  | Alterar cliente, API e testes na mesma entrega; E2E cobre o fluxo completo.                                                     |

## 10. Resultado

Como validar que a spec foi atendida:

- **Comando/verificação:** `bun run infra:up`, `bun run db:migrate`, `bun run lint`, `bun run check-types`, `bun run test`, `bun run test:integration` e `bun run test:e2e`; manualmente, conversar com dois experts, recarregar, trocar de expert e limpar uma conversa.
- **Evidência esperada:** testes de integração com duas contas verdes (isolamento, `409`, `incomplete`, limpeza, retenção); migration com rollback no comentário; `rondo_app` falhando em DDL.
- **Comportamento observável:** a conversa de cada expert reaparece depois de recarregar ou de trocar de expert, e some de vez ao limpar.

## 11. Perguntas abertas e premissas

| Pergunta/Premissa                                                                                                                                      | Impacto                                                         | Bloqueante? | Quem decide        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------- | ------------------ |
| **Premissa (compartilhada):** isolamento por usuário; clube e workspace fora do escopo.                                                                | Chave de acesso de todas as tabelas.                            | Não         | Produto            |
| **Premissa:** uma conversa por `(usuário, expert)`, no máximo 200 mensagens, sem expiração automática.                                                  | Modelo de dados e retenção.                                     | Não         | Produto/Jurídico   |
| Pergunta: a LGPD pede uma expiração automática (por exemplo, 90 dias) para conversas com dados de saúde?                                                | Job de limpeza e texto de privacidade.                          | Não         | Jurídico/Produto   |
| **Premissa:** o modelo recebe as últimas 20 mensagens; não há resumo de mensagens antigas.                                                              | Qualidade em conversas longas.                                  | Não         | Eng.               |
| **Premissa:** a trava de concorrência é em memória (instância única), no mesmo espírito do ADR `0005`.                                                  | Escala horizontal da API.                                       | Não         | Eng.               |

## 12. Refinamento

| Data       | O que mudou            | Motivo                                          |
| ---------- | ---------------------- | ----------------------------------------------- |
| 2026-11-17 | Spec criada (rascunho) | Quebra do épico de experts (`breakdown-specs`). |
| 2026-11-17 | R2, R4 e R8 detalhados (validação de `limit` e `before`, respostas incompletas no contexto, remoção na mesma transação); ADR no passo 8 | Auditoria: cursor e limites sem critério de erro, ambiguidade sobre `incomplete` e atomicidade da retenção; `RULES.md` §5 pede ADR para modelo de dados |
