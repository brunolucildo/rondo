# 0025 — Gerenciar e excluir conexões

> Spec executável. Preencha todas as seções; `TODO` é lacuna, não requisito.
> Use `create-spec` para criar, `refine-spec` para auditar e `implement-me` para executar.

- **Status:** concluída
- **Slug:** 0025-connections-manage
- **Data:** 2026-11-17
- **Atualizado em:** 2026-11-17
- **Owner:** Produto/Jurídico (retenção e textos); Time de engenharia (execução)
- **Relacionados:** mapa `.plans/experts-breakdown.md`; `.docs/BUSINESS.md` §5 item 5 (revogação de acesso e remoção dos dados indexados), §9 item 6 (retenção e LGPD), §10 (histórico e citações sobrevivem à revogação conforme a política de retenção); `.docs/ARCHITECTURE.md` §4.6; ADR `0014`. **Depende de:** 0022 (`deleteByConnection` e `deleteAllForUser`), 0023 (conexões e a tabela de dedup), 0024 (citações guardadas). **Destrava:** o ciclo de vida de qualquer conexão nova da fase 2 (imagem, URL, áudio e vídeo reaproveitam a listagem e a exclusão).

## 1. Escopo

### Dentro do escopo

- `GET /api/v1/connections`: lista as conexões do usuário (nome, tipo, tamanho, status, quantidade de chunks, data).
- `DELETE /api/v1/connections/:id`: **exclusão completa** de uma conexão: vetores no Weaviate, registro no Postgres (inclusive a identidade de dedup) e qualquer resíduo.
- `DELETE /api/v1/connections`: **excluir todas** as conexões do usuário e o tenant dele no Weaviate.
- **Painel de conexões** no botão flutuante da 0023: abas ou seções "Add" e "Your connections", com a lista, o status, a exclusão individual e "Delete all", ambas com confirmação.
- **Citações de fontes excluídas:** no histórico, a citação de uma conexão que não existe mais aparece como "Source removed" (sem nome nem trecho).
- Política de retenção: a conexão fica até o usuário excluir; sem expiração automática nesta spec.
- Telemetria sem conteúdo, `ARCHITECTURE.md`, `BUSINESS.md` (revogação e retenção) e `QA.md`.

### Fora do escopo

- Upload, dedup e processamento: **0023**. Respostas e citações: **0024** (esta spec só define a exibição de uma citação cuja fonte foi excluída).
- Excluir a **conta** do usuário e a cascata de toda a conta (conversas, sessões e conexões): backlog (a exclusão de conta não existe hoje).
- Apagar conversas: **0020** (`Clear conversation`).
- Expiração automática das conexões, arquivamento, lixeira ou desfazer a exclusão: backlog.
- Renomear, reprocessar manualmente, baixar o arquivo original (não é guardado) e organizar conexões em pastas ou por expert: backlog.
- Compartilhar conexões entre usuários.
- Exclusão **física** do dado em backups: não há backup do Postgres nem do Weaviate (dívida de `ARCHITECTURE.md` §6).

## 2. Contexto

**Estado atual.** Depois da 0023 o usuário indexa arquivos, mas **não vê** o que indexou nem consegue removê-lo. A única saída é o `infra:reset` do ambiente inteiro. `BUSINESS.md` §5 exige, para qualquer conector, **revogação de acesso e remoção dos dados indexados**; §9 item 6 pergunta como atender a exclusão (LGPD). Os arquivos podem conter dados de saúde de atletas (dado pessoal sensível).

**Por que agora.** Esta spec fecha o ciclo de vida: criar (0023), usar (0024) e **excluir (0025)**. Sem ela o produto armazena dados sensíveis sem permitir que o usuário os controle. É uma ação **irreversível** com risco próprio, por isso é uma spec separada da 0023.

**O que "excluir" significa.** Remove (1) os vetores da conexão no Weaviate, (2) a linha em `connections`, que carrega o `content_hash` da dedup, e (3) nada mais precisa ser apagado, pois o arquivo original nunca foi guardado e as citações guardam só `connectionId`, nome, página e posição. Depois de excluída, subir o mesmo arquivo de novo o **processa do zero**.

## 3. Necessidade de negócio

| Item                     | Descrição                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Usuário/papel afetado    | Pessoa autenticada dona das conexões.                                                                              |
| Decisão ou ação que muda | Vê o que o expert sabe sobre ela e remove o que não deve mais estar lá, sem pedir ajuda ao suporte.                |
| Resultado esperado       | Lista fiel das conexões e exclusão completa, imediata e verificável, individual ou total.                          |
| Métrica de sucesso       | 0 resíduos de vetores ou de registros após a exclusão; tempo de exclusão de uma conexão abaixo de 3 s; exclusões concluídas versus iniciadas. |

## 4. Requisitos

| ID  | Requisito                                                                                                                                                                                                                                                                                                                                     | Prioridade | Critério de aceite                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `GET /api/v1/connections` devolve **só** as conexões do usuário da sessão, da mais recente para a mais antiga, com `id`, `name`, `kind`, `sizeBytes`, `status`, `chunkCount`, `errorCode` e `createdAt`; sem conexões devolve lista vazia.                                                                                                     | Must       | Given o usuário A com 3 conexões e o B com 2, When A lista, Then recebe 3 em ordem decrescente de data e nenhuma de B. Given nenhuma conexão, Then `200` com `connections: []`. Given sem sessão, Then 401.                                                                                                          |
| R2  | `DELETE /api/v1/connections/:id` remove, nesta ordem, os vetores da conexão no Weaviate e a linha em `connections`, e responde `204`. Conexão de outro usuário ou inexistente responde `404 CONNECTION_NOT_FOUND`; o `id` vem validado como UUID.                                                                                             | Must       | Given uma conexão `ready`, When exclui, Then `204`, o índice não devolve mais chunks dela (busca com fake e com Weaviate) e a linha não existe. Given `id` de outro usuário, Then `404` e nada é alterado. Given `id` inválido, Then `400 VALIDATION_FAILED`.                                                           |
| R3  | **Ordem e falha parcial:** se a remoção dos vetores falhar (Weaviate indisponível), a linha **não** é apagada e a resposta é `503 KNOWLEDGE_UNAVAILABLE`; repetir a exclusão conclui o trabalho (idempotente). Se os vetores já foram removidos e a linha não existe mais, repetir devolve `404` sem erro de infraestrutura.                    | Must       | Given o Weaviate parado, When exclui, Then `503`, a conexão continua listada e **nenhum dado foi perdido de forma inconsistente**. Given o Weaviate de volta, When repete, Then `204`. Given a repetição depois do sucesso, Then `404 CONNECTION_NOT_FOUND`.                                                          |
| R4  | **Exclusão durante processamento:** excluir uma conexão `processing` é recusado com `409 CONNECTION_PROCESSING`; `failed` e `ready` podem ser excluídas; uma `processing` há mais de 15 minutos conta como `failed` (regra da 0023) e também pode.                                                                                                                                                                                        | Must       | Given uma conexão `processing`, When exclui, Then `409 CONNECTION_PROCESSING` e nada é alterado. Given `failed`, Then `204`.                                                                                                                                                                                          |
| R5  | **Reuso após a exclusão:** o registro de dedup some junto da linha, então reenviar o mesmo arquivo cria uma conexão nova e reprocessa (embeddings e índice).                                                                                                                                                                                  | Must       | Given um arquivo excluído, When o mesmo arquivo é enviado de novo, Then `deduplicated` é `false`, o `id` é novo e os embeddings e o índice são chamados.                                                                                                                                                            |
| R6  | `DELETE /api/v1/connections` apaga **todas** as conexões do usuário: remove o tenant dele no Weaviate (`deleteAllForUser`) e todas as linhas dele em `connections`, respondendo `204`; é idempotente. Recusa com `409 CONNECTION_PROCESSING` se alguma estiver `processing`.                                                                     | Must       | Given um usuário com 5 conexões, When `DELETE /connections`, Then `204`, a lista fica vazia e a busca no tenant devolve `[]`; When repete, Then `204`. Given uma `processing`, Then `409` e nada é apagado. Given outro usuário, Then os dados dele permanecem.                                                        |
| R7  | **Citações no histórico:** uma citação (0024) cuja conexão foi excluída aparece na conversa como "Source removed" (sem nome e sem trecho); as demais citações continuam normais. A resposta do expert em si **permanece** no histórico (é do usuário, e se apaga em `Clear conversation`, 0020).                                                | Must       | Given uma resposta que citava a conexão excluída, When abre a conversa, Then a citação mostra "Source removed", sem o nome da fonte; a resposta continua visível. Given outra citação cuja conexão existe, Then mostra o nome.                                                                                       |
| R8  | **Painel de conexões** (a partir do botão flutuante da 0023): lista com nome, tipo, tamanho, status e data; estado vazio ("No connections yet"); carregando; erro com `Try again`; exclusão individual e "Delete all" com **diálogo de confirmação** que nomeia o que será apagado e avisa que não há como desfazer; foco e teclado corretos; funciona em 375 px. | Must       | Given conexões, When abre o painel, Then vê a lista; When clica em `Delete` e confirma, Then a linha some após `204`; When cancela, Then nada muda. Given `Delete all`, Then o diálogo cita a quantidade e o aviso de irreversibilidade. Given falha, Then mantém a linha e mostra `Try again`. Axe sem violações.        |
| R9  | **Privacidade e telemetria:** nenhum nome de arquivo, conteúdo, `connectionId` ou `userId` em logs, spans ou métricas; contador `connection.deletions` (`scope` `single`/`all`, `outcome`) e log `event: "connection_deleted"` só com escopo, resultado e duração.                                                                               | Must       | Given o sentinela no nome do arquivo, When lista e exclui, Then não aparece em log, span ou métrica.                                                                                                                                                                                                                |
| R10 | **Retenção documentada:** `BUSINESS.md` e `QA.md` registram que as conexões ficam até a exclusão, que o original nunca é guardado, e descrevem como atender a um pedido de exclusão de titular (o usuário usa "Delete all"; a exclusão de conta é backlog).                                                                                      | Should     | Given os documentos, Then descrevem a retenção, a exclusão e a lacuna da exclusão de conta.                                                                                                                                                                                                                         |

## 5. Fluxos e estados

- **Caminho feliz:** o usuário abre o painel pelo botão flutuante, vê as conexões, clica em `Delete` numa delas, confirma; o servidor apaga os vetores, depois a linha; a conexão sai da lista; a citação dela no histórico passa a "Source removed".
- **Vazio:** "No connections yet" com o atalho para adicionar um arquivo.
- **Carregando:** esqueleto da lista; botões de exclusão desabilitados durante a operação.
- **Erro:** falha ao listar → `Try again`; `503 KNOWLEDGE_UNAVAILABLE` ao excluir → mensagem "We couldn't delete this connection. Try again." e a linha permanece; `409 CONNECTION_PROCESSING` → "Wait for it to finish."; `404` → a lista é recarregada (outro cliente já removeu).
- **Sucesso parcial:** "Delete all" que encontra uma conexão `processing` recusa tudo (nada é apagado pela metade); uma exclusão individual que falha no índice não perde a linha.
- **Cancelamento/retry:** fechar o diálogo cancela; repetir uma exclusão é seguro (idempotente); o usuário pode excluir de novo depois do `503`.

## 6. Acceptance Criteria

- [x] Given dois usuários, Then `GET /connections` devolve só as do usuário da sessão, da mais recente para a mais antiga.
- [x] Given uma conexão `ready`, When `DELETE`, Then `204`, o índice não devolve mais chunks e a linha não existe.
- [x] Given `id` de outro usuário, Then `404` sem alterar nada; given `id` inválido, `400`.
- [x] Given o Weaviate parado, Then `503` e a linha permanece; given a repetição com o Weaviate de volta, `204`.
- [x] Given `processing`, Then `409 CONNECTION_PROCESSING`; given `failed`, `204`.
- [x] Given um arquivo excluído, When reenviado, Then é uma conexão nova, com embeddings e índice chamados.
- [x] Given `DELETE /connections`, Then `204`, lista vazia, tenant removido; repetir é `204`; com uma `processing`, `409` e nada é apagado.
- [x] Given uma citação de conexão excluída, Then a conversa mostra "Source removed", sem nome, e a resposta permanece.
- [x] Given o painel, Then lista, estado vazio, carregando, erro, exclusão e "Delete all" funcionam com confirmação e por teclado, em 375 px.
- [x] Given o sentinela no nome do arquivo, Then não aparece em log, span ou métrica.
- [x] Given `bun run lint`, `check-types`, `test`, `test:integration` e `test:e2e`, Then passam sem chamar a OpenAI.

## 7. O que fazer

1. Acrescentar a `modules/connections/` os casos de uso `ListConnections`, `DeleteConnection` e `DeleteAllConnections`, com um request handler por endpoint (ADR `0014`) e as operações de repositório necessárias (listar por usuário, excluir por `id` e `user_id`, excluir todas as do usuário, checar `processing`).
2. Implementar a exclusão na ordem **vetores primeiro, linha depois**, idempotente, com o mapeamento de `KnowledgeIndexUnavailableError` para `503 KNOWLEDGE_UNAVAILABLE`.
3. Implementar a recusa de `processing` e a exclusão total com `deleteAllForUser` da 0022.
4. Ajustar a leitura da conversa (0020 e 0024) para resolver cada citação: se a conexão não existe mais, devolver "removida" sem nome.
5. Construir o painel de conexões na interface (lista, estados, diálogo de confirmação, `Delete all`) a partir do botão flutuante da 0023.
6. Registrar a telemetria sem conteúdo.
7. Escrever os testes: unidade (ordem e idempotência), integração (isolamento entre dois usuários, falha do índice, `409`, reuso após exclusão, exclusão total, citação removida), componente e E2E (listar, excluir, cancelar, "Delete all").
8. Atualizar `ARCHITECTURE.md`, `BUSINESS.md` (§5 item 5 e §9 item 6) e `QA.md`, e registrar o ADR da exclusão de conexões (ordem vetores → linha, idempotência e retenção), conforme `RULES.md` §5.

## 8. O que não fazer

- Não apagar a linha antes dos vetores: uma falha no meio não pode deixar dados órfãos sem registro.
- Não aceitar `userId` do corpo ou da URL, nem excluir uma conexão sem conferir o dono.
- Não apagar conversas, mensagens ou a conta do usuário (0020 e backlog).
- Não implementar lixeira, desfazer, expiração automática, renomear ou reprocessar.
- Não logar nome de arquivo, conteúdo, `connectionId` ou `userId`.
- Não mostrar o nome de uma fonte excluída em citações.
- Não excluir uma conexão `processing`.
- Não chamar a OpenAI nos testes automatizados.

## 9. Riscos e dependências

| Tipo        | Descrição                                                                                                     | Mitigação                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Dependência | 0022 (`deleteByConnection`, `deleteAllForUser`), 0023 (conexões) e 0024 (citações).                           | Implementar depois delas; fakes das portas nos testes.                                                                             |
| Risco       | Exclusão parcial deixa vetores órfãos ou registro sem vetores.                                                | Ordem vetores → linha, operações idempotentes, repetição segura (R3) e teste com falha injetada.                                   |
| Risco       | Ação irreversível feita por engano.                                                                           | Diálogo de confirmação que nomeia o item e avisa que não há desfazer; "Delete all" cita a quantidade.                              |
| Risco       | Dado removido continua em backups ou no histórico de logs.                                                    | Não há backups hoje (dívida registrada); logs não contêm conteúdo nem nome; documentar no `BUSINESS.md`.                           |
| Risco       | A resposta do expert pode conter trechos do documento mesmo depois da exclusão da fonte.                       | A resposta é do usuário e se apaga em `Clear conversation` (0020); o aviso do painel de exclusão informa isso; Produto decide se quer apagar também as respostas (§11). |
| Risco       | Exclusão concorrente com uma pergunta em andamento (a recuperação já pegou trechos).                          | Aceito: a resposta em curso termina com as citações já recuperadas; a próxima pergunta já não encontra a fonte.                    |

## 10. Resultado

Como validar que a spec foi atendida:

- **Comando/verificação:** `bun run infra:up`, `bun run lint`, `bun run check-types`, `bun run test`, `bun run test:integration`, `bun run test:e2e`; manualmente, anexar dois arquivos, perguntar usando-os, abrir o painel, excluir um, perguntar de novo e conferir "Source removed" no histórico; usar "Delete all".
- **Evidência esperada:** teste de integração de exclusão com falha injetada do Weaviate (sem inconsistência); teste de isolamento com duas contas; teste que confirma a busca vazia após `deleteAllForUser`.
- **Comportamento observável:** o painel mostra o que está conectado; excluir remove da lista e do índice; reenviar o mesmo arquivo reprocessa; as fontes excluídas aparecem como "Source removed" no histórico.

## 11. Perguntas abertas e premissas

| Pergunta/Premissa                                                                                                                                              | Impacto                                                                   | Bloqueante? | Quem decide        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------- | ------------------ |
| **Premissa (compartilhada):** exclusão definitiva e sem desfazer; o original nunca foi guardado, então não há mais nada a apagar além de vetores e linha.        | Privacidade e simplicidade; sem recuperação.                              | Não         | Produto/Jurídico   |
| **Premissa (compartilhada):** as conexões ficam até o usuário excluir; sem expiração automática.                                                                | Retenção de dados de saúde por tempo indeterminado.                       | Não         | Produto/Jurídico   |
| **Premissa:** excluir uma fonte mantém as respostas do histórico; as citações viram "Source removed".                                                           | Resíduo de conteúdo nas respostas já geradas.                             | Não         | Produto/Jurídico   |
| Pergunta: ao excluir uma conexão, as respostas do histórico que a citaram também devem ser apagadas (LGPD, dado de saúde)?                                      | Regra de exclusão em cascata entre conexões e mensagens (0020).           | Não         | Jurídico           |
| Pergunta: o atendimento de um pedido de exclusão de conta de titular será feito por "Delete all" mais `Clear conversation` por expert até existir a exclusão de conta? | Processo operacional e prioridade da spec de exclusão de conta no backlog. | Não         | Produto/Jurídico   |

## 12. Refinamento

| Data       | O que mudou            | Motivo                                          |
| ---------- | ---------------------- | ----------------------------------------------- |
| 2026-11-17 | Spec criada (rascunho) | Quebra do épico de experts (`breakdown-specs`). |
| 2026-11-17 | Passo 8 inclui o ADR da exclusão | Auditoria: `RULES.md` §5 pede ADR para decisão de dados e retenção; nenhum requisito alterado |
| 2026-11-17 | Implementada (status concluída; critérios marcados) | Execução do `implement-me` (orquestrada): API de listagem e exclusão, citações removidas, painel, testes, docs e ADR provisório `0026-exclusao-de-conexoes` |

### Premissas registradas na implementação

- A exclusão de conexão `processing` há menos de 15 minutos é recusada com `409`; o `delete` da linha repete a condição para que um reenvio que reivindicou o `failed` no meio não perca a linha (também `409`).
- A leitura da conversa devolve cada citação com `removed`; a de fonte excluída vai como `{ connectionId, removed: true }`, sem nome. A interface junta várias citações da mesma conexão excluída em uma linha "Source removed".
- O painel é aberto por um botão "Your connections" ao lado de "Add connection" (as seções "Add" e "Your connections" ficam no mesmo painel); depois de excluir, as fontes em tela viram "Source removed" na hora, sem recarregar.
- Sem rate limit novo nas rotas de exclusão e listagem (por usuário autenticado, idempotentes).
