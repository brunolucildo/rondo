# 0022 — Fundação do conhecimento: Weaviate local e embeddings

> Spec executável. Preencha todas as seções; `TODO` é lacuna, não requisito.
> Use `create-spec` para criar, `refine-spec` para auditar e `implement-me` para executar.

- **Status:** pronta
- **Slug:** 0022-rag-weaviate-foundation
- **Data:** 2026-11-17
- **Atualizado em:** 2026-11-17
- **Owner:** Time de engenharia (infra e contrato); Produto (retenção e LGPD)
- **Relacionados:** mapa `.plans/experts-breakdown.md`; `.docs/ARCHITECTURE.md` §2.1 (portas), §4.4 e §7 (integrações externas: timeout, retry, logs sem PII); `docker-compose.yml`; `scripts/infra-up.ts`, `infra-down.ts`, `infra-reset.ts`; ADR `0015`. **Depende de:** nenhuma spec pendente (a chave da OpenAI é a da 0019, mas esta spec não conversa com o chat). **Habilitadora:** serve a 0023, 0024, 0025 e às specs da fase 2 (imagem, URL, áudio e vídeo).

## 1. Escopo

### Dentro do escopo

- **Serviço `weaviate` no Docker Compose**, com versão fixada (sem `latest`), volume persistente, healthcheck e portas publicadas **só em `127.0.0.1`**, com autenticação por chave de API.
- **Integração dos scripts:** `infra:up` espera o Weaviate ficar saudável; `infra:down` o derruba; `infra:reset` apaga o volume do Weaviate junto com os demais.
- **Porta de domínio `KnowledgeIndex`** (gravar chunks, buscar por similaridade, apagar por conexão, apagar tudo de um usuário) e **adaptador Weaviate** com `@langchain/weaviate` e o client oficial.
- **Isolamento por usuário** com **multi-tenancy do Weaviate**: um tenant por usuário, criado sob demanda; nenhuma busca atravessa tenants.
- **Porta `EmbeddingsGenerator`** e adaptador `@langchain/openai` com `text-embedding-3-small`: lote, timeout, retry limitado. Os vetores são calculados pela aplicação (o Weaviate não chama provedor nenhum).
- Esquema da coleção de chunks (propriedades de metadados sem PII), variáveis de ambiente, telemetria sem conteúdo, `.env.example`, `ARCHITECTURE.md`, `QA.md` e **ADR** (Weaviate com tenant por usuário).

### Fora do escopo

- Upload, extração, chunking, hash e dedup: **0023** (esta spec só oferece o índice e os embeddings).
- Busca no fluxo do chat, citações e instruções de resposta: **0024**.
- Listar e excluir conexões na interface e a regra de LGPD da exclusão completa: **0025** (aqui existe só a operação de índice usada por ela).
- LangSmith, Studio e traces ricos do LangGraph: backlog/fase 2.
- Busca híbrida, reranking, módulos vetorizadores do Weaviate, replicação, backup do Weaviate e alta disponibilidade: backlog.
- Qualquer chamada a Weaviate vinda do navegador: o app só fala com a API.

## 2. Contexto

**Estado atual.** O Compose sobe Postgres, Grafana, Loki, Tempo, Mimir e o OTel Collector. Não existe banco vetorial, nem embeddings, nem dependência de `@langchain/*` voltada a dados. `BUSINESS.md` §5 exige para qualquer conector ingestão idempotente, metadados de origem, citação e remoção dos dados indexados; `ARCHITECTURE.md` §7 manda que conectores e serviços externos fiquem atrás de uma porta em `infrastructure`.

**Por que uma spec própria.** Três specs (0023, 0024, 0025) e as da fase 2 precisam do mesmo índice. Colocá-lo dentro da 0023 esconderia a decisão de isolamento e obrigaria as demais a depender de um fluxo de upload. A spec é mínima: infra, contrato e prova de isolamento.

**Isolamento.** Os dados indexados podem conter dados de saúde de atletas (LGPD, dado sensível). O vazamento entre usuários é o risco principal; por isso o isolamento é **estrutural** (tenant por usuário), não só um filtro de consulta.

## 3. Necessidade de negócio

| Item                     | Descrição                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Usuário/papel afetado    | Indireto: toda pessoa que conectar dados aos experts; diretamente, quem desenvolve e opera o ambiente local.         |
| Decisão ou ação que muda | Passa a existir um lugar seguro e local para os trechos dos documentos, que o expert consulta nas specs seguintes.   |
| Resultado esperado       | `bun run infra:up` sobe o Weaviate saudável; a API grava e busca chunks por usuário, sem vazar entre usuários.      |
| Métrica de sucesso       | Teste de isolamento verde (0 resultados cruzados); busca em até 300 ms em 10 mil chunks no ambiente local.          |

## 4. Requisitos

| ID  | Requisito                                                                                                                                                                                                                                                                                                  | Prioridade | Critério de aceite                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | O serviço `weaviate` do Compose usa imagem com **versão fixada**, volume `weaviate-data`, healthcheck, autenticação por chave de API (anônimo desligado), **sem módulos vetorizadores**, e publica as portas HTTP (8080) e gRPC (50051) apenas em `127.0.0.1`.                                              | Must       | Given `docker compose config`, Then a imagem tem tag fixa (sem `latest`), as portas começam em `127.0.0.1:` e o acesso anônimo está desligado. Given `bun run infra:up`, Then o serviço fica `healthy`; sem a chave, uma chamada HTTP recebe 401.                               |
| R2  | `infra:up` espera o Weaviate saudável junto com o Postgres e o LGTM; `infra:down` o derruba; `infra:reset` apaga `weaviate-data`. As variáveis `WEAVIATE_URL` e `WEAVIATE_API_KEY` entram em `.env.example` (só servidor, nunca `VITE_*`).                                                                  | Must       | Given `bun run infra:reset` seguido de `infra:up`, Then o Weaviate sobe vazio e saudável. Given `.env.example`, Then lista as duas variáveis e `VITE_*` não contém nenhuma delas.                                                                                                |
| R3  | A porta `KnowledgeIndex` oferece: `upsert(userId, chunks)`, `search(userId, queryVector, { limit, connectionIds? })`, `deleteByConnection(userId, connectionId)` e `deleteAllForUser(userId)`; cada chunk tem `connectionId`, `sourceName`, `position`, `page` (opcional), `text` e vetor. O domínio não importa Weaviate nem LangChain. | Must       | Given o código, Then `domain/` não importa `weaviate-client` nem `@langchain/*` (teste de fronteira como `email-boundaries.spec.ts`). Given um fake em memória da porta, Then os casos de uso das specs seguintes rodam sem Weaviate.                                            |
| R4  | **Isolamento por tenant:** cada usuário tem um tenant (nome derivado do UUID), criado no primeiro `upsert`; `search` e `delete*` operam **somente** no tenant do `userId` recebido; consultar um tenant inexistente devolve lista vazia sem erro e sem criá-lo.                                             | Must       | Given os usuários A e B com chunks do mesmo texto, When B busca por esse texto, Then recebe só chunks de B e nunca de A; When apaga os de A, Then os de B continuam. Given um usuário sem tenant, When busca, Then `[]` e o tenant não é criado.                                |
| R5  | `deleteByConnection` remove todos os chunks daquela conexão e é idempotente; `deleteAllForUser` remove o tenant inteiro (todos os dados do usuário no Weaviate) e é idempotente.                                                                                                                           | Must       | Given 3 conexões de um usuário, When `deleteByConnection` da segunda, Then restam as outras duas; When repete, Then sem erro. When `deleteAllForUser`, Then a busca devolve `[]` e o tenant não existe mais.                                                                    |
| R6  | `EmbeddingsGenerator` gera vetores com `text-embedding-3-small` em lotes (até 96 textos por chamada), com timeout de 20 s por chamada, até 3 tentativas com espera crescente em 429 e 5xx, e **sem logar o texto**. Sem `OPENAI_API_KEY` falha com erro tipado sem chamar a rede.                            | Must       | Given o cliente falso que responde 429 duas vezes e depois 200, Then o lote tem sucesso na 3ª tentativa. Given 429 em todas, Then `EmbeddingsUnavailableError` após 3 tentativas. Given 200 textos, Then são enviados em 3 chamadas. Given o sentinela, Then não aparece em log.          |
| R7  | Falhas do Weaviate viram erros tipados do domínio (`KnowledgeIndexUnavailableError` para conexão, timeout e 5xx) com timeout de 10 s, até 3 tentativas com espera crescente para operações idempotentes, e sem o texto, vetor ou nome do tenant em mensagens, logs ou spans.                              | Must       | Given o Weaviate parado, When `search`, Then `KnowledgeIndexUnavailableError` em até o timeout, sem stack trace de rede no erro público. Given o log, Then não há texto de chunk, vetor ou UUID de tenant.                                                                       |
| R8  | Telemetria sem conteúdo: métrica de duração das operações do índice (`operation`, `outcome`) e das chamadas de embeddings (`outcome`, quantidade de textos), no mesmo catálogo de sinais do `ARCHITECTURE.md` §4.4, e log `event` só com operação, resultado e duração.                                    | Should     | Given operações com sucesso e falha, Then as métricas aparecem no Mimir com as dimensões fechadas e nenhuma contém texto, `connectionId` ou `userId`.                                                                                                                           |
| R9  | Documentação e decisão: `ARCHITECTURE.md` (portas 8080 e 50051 em §2.1, módulo e porta do índice, variáveis), `QA.md` (como subir e validar) e um ADR "Weaviate com multi-tenancy por usuário e vetores calculados pela aplicação".                                                                       | Must     | Given o repositório, Then os documentos citam a versão fixada, o ADR e a regra de isolamento; o item de dívida das imagens `:latest` continua aberto para o resto do Compose.                                                                                                    |

## 5. Fluxos e estados

- **Caminho feliz:** `bun run infra:up` sobe o Weaviate; a API (em specs seguintes) grava os chunks de um usuário no tenant dele; a busca por vetor devolve os mais próximos só desse tenant.
- **Vazio:** tenant inexistente ou sem chunks → `[]`.
- **Carregando:** primeira operação de um usuário cria o tenant; a espera conta no timeout.
- **Erro:** Weaviate fora do ar, lento ou com chave errada → erro tipado de indisponibilidade; OpenAI de embeddings com 429/5xx → retry limitado e `EmbeddingsUnavailableError`; os consumidores (0023 e 0024) decidem a resposta HTTP.
- **Sucesso parcial:** um lote de embeddings falha após outros terem sido gerados → nada é gravado parcialmente nesta camada; o consumidor (0023) trata a compensação.
- **Cancelamento/retry:** operações idempotentes (`delete*`, `upsert` por chunk com id estável) podem ser repetidas sem efeito colateral.

## 6. Acceptance Criteria

- [ ] Given `docker compose config`, Then a imagem do Weaviate tem tag fixa, as portas são `127.0.0.1:` e o acesso anônimo está desligado.
- [ ] Given `bun run infra:up`, Then o Weaviate fica saudável e sem a chave de API uma chamada recebe 401.
- [ ] Given `bun run infra:reset`, Then o volume do Weaviate é apagado e o serviço volta vazio.
- [ ] Given dois usuários com o mesmo texto, Then a busca de um nunca devolve chunks do outro.
- [ ] Given `deleteByConnection` e `deleteAllForUser`, Then removem o que devem e são idempotentes.
- [ ] Given um tenant inexistente, Then a busca devolve `[]` e não cria o tenant.
- [ ] Given 200 textos, Then os embeddings saem em 3 chamadas; given 429 repetido, Then há 3 tentativas e `EmbeddingsUnavailableError`.
- [ ] Given o Weaviate parado, Then `KnowledgeIndexUnavailableError` dentro do timeout, sem detalhes de rede no erro público.
- [ ] Given o sentinela, Then nenhum log, span ou métrica contém texto, vetor, `userId` ou nome de tenant.
- [ ] Given `domain/`, Then não importa Weaviate nem LangChain.
- [ ] Given o Weaviate parado, Then só os testes de integração do módulo `knowledge` falham, com a instrução de rodar `bun run infra:up`; os demais testes de integração continuam passando.
- [ ] Given `bun run lint`, `check-types`, `test` e `test:integration` (com o Weaviate local), Then passam; os testes não chamam a OpenAI.

## 7. O que fazer

1. Acrescentar o serviço `weaviate` ao `docker-compose.yml` (versão fixada, volume, healthcheck, chave de API, portas em `127.0.0.1`, sem vetorizadores) e o volume `weaviate-data`.
2. Ajustar `scripts/infra-up.ts`, `infra-down.ts` e `infra-reset.ts` para o novo serviço e atualizar o `.env.example`.
3. Criar o módulo `modules/knowledge/` com a porta `KnowledgeIndex`, o adaptador Weaviate (`@langchain/weaviate` e client oficial), a porta `EmbeddingsGenerator` e o adaptador OpenAI, mais fakes para teste.
4. Definir o esquema da coleção (multi-tenancy ligada, propriedades de metadados, vetor fornecido pela aplicação) e a criação sob demanda de tenants.
5. Implementar timeout, retry limitado e os erros tipados; garantir que nenhum texto, vetor ou tenant entra em mensagem, log ou span.
6. Registrar a telemetria sem conteúdo no padrão do `ARCHITECTURE.md` §4.4.
7. Escrever os testes: unidade (lotes, retry, erros), fronteira de domínio, integração com o Weaviate local (isolamento, delete, idempotência, tenant inexistente); o `globalSetup` da integração só exige o Weaviate para os testes do módulo `knowledge`, para que os demais não passem a depender dele.
8. Atualizar `ARCHITECTURE.md`, `QA.md` e registrar o ADR.

## 8. O que não fazer

- Não publicar o Weaviate em `0.0.0.0` nem deixá-lo sem autenticação.
- Não usar `latest` para a imagem do Weaviate.
- Não ativar módulos vetorizadores (`text2vec-*`): o Weaviate não pode chamar a OpenAI por conta própria.
- Não misturar usuários na mesma partição lógica com filtro de consulta como única proteção.
- Não logar texto, vetor, `userId` ou nome de tenant; não incluí-los em métricas.
- Não implementar upload, chunking, dedup, busca no chat ou telas (0023 a 0025).
- Não expor Weaviate ao navegador nem criar variáveis `VITE_*` para ele.
- Não chamar a OpenAI nos testes automatizados.

## 9. Riscos e dependências

| Tipo        | Descrição                                                                                                  | Mitigação                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Dependência | Docker, com RAM suficiente para mais um serviço.                                                           | Documentar o consumo no `QA.md`; o serviço pode ser omitido nos testes unitários (fake em memória).                 |
| Dependência | OpenAI Embeddings (`text-embedding-3-small`) é a única chamada externa desta spec.                         | Porta com fake nos testes; erro tipado sem chave; timeout e retry limitados.                                        |
| Risco       | Vazamento entre usuários (dados de saúde de atletas).                                                      | Tenant por usuário (estrutural), teste de isolamento com duas contas, auditoria do `userId` sempre vindo da sessão. |
| Risco       | Mudança de API do client Weaviate ou do `@langchain/weaviate`.                                             | Fixar versões, isolar no adaptador, versionar a imagem do servidor.                                                 |
| Risco       | Trocar o modelo de embeddings muda a dimensão e invalida os vetores existentes.                            | Registrar modelo e dimensão na coleção; trocar exige reindexar (fora do escopo); documentar no ADR.                 |
| Risco       | Multi-tenancy tem limite prático de tenants por nó.                                                        | Aceito para o volume local; registrar no ADR e revisar antes de um deploy compartilhado.                            |

## 10. Resultado

Como validar que a spec foi atendida:

- **Comando/verificação:** `docker compose config`; `bun run infra:up` (Weaviate `healthy`); `bun run lint`, `bun run check-types`, `bun run test`, `bun run test:integration`; `bun run infra:reset` e `infra:up` para confirmar o volume limpo.
- **Evidência esperada:** teste de integração de isolamento verde com dois usuários; teste de fronteira do domínio; configuração do Compose com versão fixada e portas locais; ADR registrado.
- **Comportamento observável:** o Weaviate sobe com o resto da infra, aceita só chamadas autenticadas vindas do próprio computador e devolve resultados separados por usuário.

## 11. Perguntas abertas e premissas

| Pergunta/Premissa                                                                                                                         | Impacto                                                  | Bloqueante? | Quem decide |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------- | ----------- |
| **Premissa (compartilhada):** vetores com `text-embedding-3-small` (1.536 dimensões), calculados pela aplicação.                           | Dimensão da coleção e custo por indexação.               | Não         | Eng.        |
| **Premissa (compartilhada):** isolamento por usuário, com um tenant do Weaviate por usuário.                                              | Modelo de dados e vazamento entre usuários.              | Não         | Produto     |
| **Premissa:** versão exata do Weaviate fixada na implementação, escolhida entre as estáveis e registrada no ADR.                          | Compatibilidade com `@langchain/weaviate`.               | Não         | Eng.        |
| **Premissa:** o Weaviate local usa uma chave de API própria em `.env`; o padrão de `.env.example` é um valor de desenvolvimento.          | Segurança do ambiente local.                             | Não         | Eng.        |
| Pergunta: o Weaviate precisa de backup quando houver deploy (hoje o volume é descartável, como o do Postgres)?                            | Dívida de infra (§6 do `ARCHITECTURE.md`).               | Não         | Eng./Produto |
| **Premissa:** os testes de integração do índice usam o Weaviate local real (`infra:up`); os embeddings são falsos nos testes e, no E2E, o gerador falso escolhido por `NODE_ENV=test`, como o modelo falso da 0019. | Isolamento dos testes de chamadas externas. | Não | Eng. |

## 12. Refinamento

| Data       | O que mudou            | Motivo                                          |
| ---------- | ---------------------- | ----------------------------------------------- |
| 2026-11-17 | Spec criada (rascunho) | Quebra do épico de experts (`breakdown-specs`). |
| 2026-11-17 | R9 (ADR e documentação) promovido a Must; critério e passo de teste ajustados para o Weaviate só ser exigido nos testes do módulo `knowledge`; premissa de testes | `RULES.md` §5 exige ADR para tecnologia nova; o `globalSetup` atual exige o banco e uma dependência nova quebraria `test:integration` sem Weaviate |
