# 0023 — Conexões de arquivos de texto (PDF, TXT e Markdown) com deduplicação

> Spec executável. Preencha todas as seções; `TODO` é lacuna, não requisito.
> Use `create-spec` para criar, `refine-spec` para auditar e `implement-me` para executar.

- **Status:** pronta
- **Slug:** 0023-connections-text-files
- **Data:** 2026-11-17
- **Atualizado em:** 2026-11-17
- **Owner:** Produto (limites, textos, privacidade); Time de engenharia (execução)
- **Relacionados:** mapa `.plans/experts-breakdown.md`; `.docs/BUSINESS.md` §5 (requisitos mínimos de conector), §7 e §9 itens 4 e 6; `.docs/ARCHITECTURE.md` §4.2, §4.6 e §7 (conectores atrás de porta); ADR `0014`; documentação do LangChain.js sobre Document Loaders e `DirectoryLoader`. **Depende de:** 0019 (home e composer), 0022 (índice, embeddings e tenant por usuário). **Destrava:** 0024, 0025 e as specs de conexão da fase 2 (imagem, URL, áudio e vídeo), que reaproveitam este pipeline.

## 1. Escopo

### Dentro do escopo

- **Botão flutuante "Add connection"** na home do chat, que abre o fluxo de anexar um arquivo `.pdf`, `.txt` ou `.md`.
- `POST /api/v1/connections` (multipart): recebe o arquivo, valida, calcula a **identidade do conteúdo (SHA-256 dos bytes)** e decide entre reaproveitar uma conexão existente e processar uma nova.
- **Deduplicação por usuário:** se o usuário já tem uma conexão com o mesmo conteúdo, ela é reaproveitada **sem extrair, sem gerar embeddings e sem gravar vetores**; senão, o arquivo é processado e registrado.
- **Pipeline de processamento** com os **Document Loaders do LangChain.js** (`DirectoryLoader` sobre um diretório temporário, com `TextLoader` e `PDFLoader`; Markdown entra como texto): extração, **chunking**, embeddings (0022), gravação no Weaviate (0022) e registro no Postgres (hash, nome, tipo, tamanho, status, contagem de chunks) para a deduplicação futura.
- `GET /api/v1/connections/:id`: status da conexão (`processing`, `ready`, `failed`) para a interface acompanhar.
- **Chip de anexo** no composer com o estado (processando, pronto, falhou) e remoção do anexo antes do envio; o envio da mensagem espera os anexos ficarem `ready`.
- **Aviso de privacidade** antes do primeiro envio de arquivo.
- Migration (`connections` e unicidade do conteúdo por usuário), telemetria sem conteúdo, `.env.example` (limites), `ARCHITECTURE.md`, `BUSINESS.md` (§5 e decisões), `QA.md`.

### Fora do escopo

- O expert **usar** a conexão ao responder, e as citações: **0024** (entre a 0023 e a 0024 o arquivo fica indexado, mas as respostas ainda não o usam; implemente as duas em sequência).
- Listar as conexões e **excluí-las** (apagar arquivo, chunks, vetores e o registro de dedup): **0025**.
- Imagens (`.jpg`, `.jpeg`, `.png`), links (URL externa), áudio (`.mp3`) e vídeo (`.mp4`): fase 2 do mapa (backlog).
- Conectores com OAuth (Google Drive, Notion, Jira, Confluence etc.), sincronização contínua e agendada: backlog (`BUSINESS.md` §5).
- OCR de PDFs escaneados, tabelas complexas, planilhas e documentos Office: backlog.
- Guardar o **arquivo original**: o original **não** é retido; só o texto extraído em chunks e os metadados.
- Compartilhar conexões entre usuários e deduplicação **entre** usuários: fora (cada usuário tem a sua base).

## 2. Contexto

**Estado atual.** Após as 0019 a 0022 existem o chat, o índice vetorial local (Weaviate, tenant por usuário) e os embeddings, mas **nenhum caminho** leva um documento do usuário até o índice. Não há upload, tabela de conexões, nem regra para não indexar o mesmo conteúdo duas vezes.

**Por que agora.** O pedido é que "sempre que utilizarmos um conector" o sistema verifique se a conexão já existe; se existe, vai direto ao modelo; se não, extrai os chunks, cria os embeddings e grava no banco vetorial **e** no banco relacional para a deduplicação futura. Isso evita pagar embeddings repetidos e deixa a base consistente. `BUSINESS.md` §5 pede ingestão idempotente, metadados de origem, citação e revogação — esta spec entrega os dois primeiros.

**Dados sensíveis.** Os arquivos podem conter dados de saúde de atletas, contratos e dados de elenco. O conteúdo vai à OpenAI (embeddings) e fica no Weaviate local; por isso o conteúdo e o nome do arquivo não vão para logs, e o original não é guardado.

**Identidade de uma conexão.** Nesta spec, conteúdo igual = mesmos bytes (SHA-256). Duas versões de um mesmo documento (um ponto a mais) são conexões diferentes. O nome do arquivo não faz parte da identidade.

## 3. Necessidade de negócio

| Item                     | Descrição                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Usuário/papel afetado    | Pessoa autenticada que quer que o expert use os próprios documentos.                                                         |
| Decisão ou ação que muda | Em vez de colar trechos no chat, anexa o arquivo uma vez e reutiliza; o sistema não reprocessa o que já conhece.             |
| Resultado esperado       | PDF, TXT e Markdown viram conhecimento indexado do usuário, sem duplicação, com status visível.                              |
| Métrica de sucesso       | Taxa de reaproveitamento por dedup; tempo até `ready` (até 30 s para 100 páginas no ambiente local); falhas de extração; custo de embeddings por usuário. |

## 4. Requisitos

| ID  | Requisito                                                                                                                                                                                                                                                                                                                                                      | Prioridade | Critério de aceite                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | A home mostra o **botão flutuante "Add connection"** (alvo de toque de 44 px, rótulo acessível, foco visível) que abre o seletor de `.pdf`, `.txt` e `.md`; o arquivo escolhido vira um chip no composer.                                                                                                                                                       | Must       | Given a home, When clica no botão flutuante e escolhe `plano.pdf`, Then aparece o chip "plano.pdf" com o estado de processamento. O botão é alcançável por teclado e não cobre o último balão em 375 px.                                                                                                                                  |
| R2  | `POST /api/v1/connections` valida o arquivo antes de ler seu conteúdo: extensão e tipo entre PDF, TXT e Markdown, **assinatura dos bytes** (cabeçalho `%PDF` para PDF; texto UTF-8 válido para TXT e MD), tamanho até 20 MB, arquivo não vazio e **até 50 conexões por usuário** (a checagem só vale quando o envio criaria uma conexão nova: reenviar um arquivo que já existe é dedup, nunca `409`). Exige sessão e tem limite de requisições **por IP** (política `connection-upload` do mecanismo da ADR `0005`; premissa: 20 por 10 minutos).                           | Must       | Given `.exe` renomeado para `.pdf`, Then `400 UNSUPPORTED_FILE`. Given 21 MB, Then `413 FILE_TOO_LARGE`. Given arquivo vazio, Then `400 EMPTY_FILE`. Given a 51ª conexão, Then `409 CONNECTION_LIMIT_REACHED`. Given um usuário com 50 conexões e um arquivo que já existe, Then dedup `200`, sem `409`. Given sem sessão, Then 401. Given o excesso de requisições pelo mesmo IP, Then 429.                                                     |
| R3  | **Identidade e dedup:** o servidor calcula o SHA-256 dos bytes e procura `(user_id, content_hash)`. Existindo conexão `ready`, devolve **`200` com a conexão existente e `deduplicated: true`**, sem criar arquivo temporário, sem extração, sem chamada de embeddings e sem escrita no Weaviate. Existindo `processing`, devolve essa conexão. Existindo `failed`, reprocessa.        | Must       | Given o mesmo arquivo enviado duas vezes pelo mesmo usuário, When o segundo envio chega, Then a resposta traz o mesmo `id` com `deduplicated: true` e o fake de embeddings e do índice **não** foi chamado de novo. Given o mesmo arquivo de **outro** usuário, Then é processado de novo (bases separadas). Given o nome diferente e os mesmos bytes, Then é dedup. |
| R4  | **Concorrência:** envios simultâneos do mesmo conteúdo pelo mesmo usuário resolvem em **uma só** conexão e **um só** processamento (unicidade no banco), sem erro 500.                                                                                                                                                                                              | Must       | Given dois `POST` simultâneos com o mesmo arquivo, Then ambos recebem o mesmo `id`, existe uma única linha e os embeddings foram gerados uma vez (teste de integração com concorrência).                                                                                                                                                  |
| R5  | **Processamento** de uma conexão nova: grava o registro `processing`; escreve o arquivo num **diretório temporário exclusivo** apagado ao fim (inclusive em falha); extrai com o `DirectoryLoader` do LangChain.js (`TextLoader` para TXT e MD, `PDFLoader` para PDF); divide em chunks de cerca de 1.000 caracteres com sobreposição de 150; gera embeddings (0022); grava no Weaviate (tenant do usuário) com `connectionId`, `sourceName`, `position` e `page`; marca `ready` com a contagem de chunks. | Must       | Given um PDF de 3 páginas com o fake de embeddings, Then existem N chunks no índice do usuário com `connectionId`, `sourceName`, `position` e `page`; a linha fica `ready` com `chunk_count = N`; o diretório temporário não existe mais. Given Markdown, Then o texto é indexado com a mesma estrutura sem `page`.                          |
| R6  | **Falhas e compensação:** PDF sem texto extraível → `failed` com `NO_EXTRACTABLE_TEXT`; PDF protegido → `PDF_PROTECTED`; mais de 2.000 chunks → `TOO_MANY_CHUNKS`; indisponibilidade dos embeddings ou do Weaviate → `failed` com `PROCESSING_UNAVAILABLE`. Em qualquer falha, **os vetores já gravados daquela conexão são removidos** e o diretório temporário é apagado. Reenviar um `failed` reprocessa. Uma conexão `processing` há mais de 15 minutos (API reiniciada no meio) é tratada como `failed` com `PROCESSING_UNAVAILABLE` ao ser consultada, reenviada ou listada. | Must       | Given um PDF só de imagem, Then `failed` com `NO_EXTRACTABLE_TEXT` e nenhum chunk no índice. Given falha do Weaviate no meio, Then não restam chunks parciais da conexão e o status é `failed`. Given o reenvio do mesmo arquivo depois, Then é reprocessado e pode chegar a `ready`.                                                    |
| R7  | `GET /api/v1/connections/:id` devolve `{ id, name, kind, sizeBytes, status, chunkCount, errorCode, createdAt }` **somente do dono**; de outro usuário ou inexistente devolve `404 CONNECTION_NOT_FOUND`. O `POST` responde `202` com a conexão em `processing` enquanto processa.                                                                                   | Must       | Given a conexão do usuário A, When o usuário B consulta o `id`, Then `404`. Given um arquivo grande, When envia, Then `202` com `status: processing` e, ao concluir, o `GET` devolve `ready`.                                                                                                                                              |
| R8  | **Interface do anexo:** o chip mostra processando (indicador), pronto ou falhou (mensagem em en-US por código e `Remove`); consulta o status com espera crescente (1 s até 5 s) e para ao sair da tela; o botão `Send` fica desabilitado enquanto um anexo estiver `processing` e o envio só considera anexos `ready` ou o usuário os remove; remover o anexo **não** exclui a conexão (isso é a 0025). | Must       | Given um anexo em processamento, Then `Send` está desabilitado e o chip tem `role="status"`. Given `failed` com `NO_EXTRACTABLE_TEXT`, Then a mensagem explica e `Remove` limpa o chip. Given `Remove`, Then a conexão continua existindo (verificada pelo `GET`).                                                                          |
| R9  | **Privacidade:** antes do primeiro envio, um diálogo avisa em en-US que o conteúdo é enviado a um provedor de IA para gerar embeddings e que dados pessoais e de saúde devem ser usados com autorização; o aceite é lembrado no navegador. Nenhum **conteúdo, nome de arquivo ou hash** vai para logs, spans ou métricas; o arquivo original não é guardado.                    | Must       | Given o primeiro uso, When escolhe o arquivo, Then o diálogo aparece antes do upload e `Cancel` aborta sem enviar. Given o aceite, Then o diálogo não reaparece naquele navegador. Given o sentinela no nome e no conteúdo, Then não aparece em log, span ou métrica; e nenhuma cópia do arquivo permanece em disco.                  |
| R10 | Telemetria: contador `connection.ingestions` (`outcome`, `kind`, `deduplicated`), histograma de duração e log `event: "connection_ingested"` com `kind`, resultado, `deduplicated`, `chunkCount` e duração, no catálogo de `ARCHITECTURE.md` §4.4.                                                                                                                 | Should     | Given ingestões com sucesso, dedup e falha, Then o Mimir recebe as séries com dimensões fechadas e sem conteúdo.                                                                                                                                                                                                                         |

## 5. Fluxos e estados

- **Caminho feliz:** o usuário toca em "Add connection", aceita o aviso (primeira vez), escolhe `plano.pdf`; o chip aparece em processamento; o servidor calcula o hash, não acha, extrai, divide, gera embeddings, grava no índice e marca `ready`; o chip fica pronto e o usuário envia a pergunta.
- **Vazio:** sem anexos, o composer mostra só o botão flutuante; sem conexões, nada muda no chat.
- **Carregando:** chip com indicador e `role="status"`; `Send` desabilitado até todos os anexos ficarem prontos ou serem removidos.
- **Erro:** extensão ou assinatura inválida, arquivo vazio, grande demais ou limite de conexões → mensagem por código no chip, sem enviar mais nada; sem texto extraível, PDF protegido ou excesso de chunks → `failed` com mensagem clara; indisponibilidade do provedor ou do Weaviate → `failed` com `PROCESSING_UNAVAILABLE` e `Try again`.
- **Sucesso parcial:** várias pessoas ou abas enviando o mesmo arquivo resolvem numa só conexão; um arquivo `failed` não impede os demais anexos.
- **Cancelamento/retry:** `Remove` retira o chip sem excluir a conexão; fechar a página durante o processamento não interrompe o servidor e o `GET` mostra o resultado depois; reenviar um `failed` reprocessa; reenviar um `ready` é dedup.

## 6. Acceptance Criteria

- [ ] Given um `.exe` renomeado para `.pdf`, Then `400 UNSUPPORTED_FILE`; given 21 MB, `413 FILE_TOO_LARGE`; given vazio, `400 EMPTY_FILE`; given a 51ª conexão, `409 CONNECTION_LIMIT_REACHED`.
- [ ] Given o mesmo arquivo enviado duas vezes pelo mesmo usuário, Then o segundo retorna `deduplicated: true` e nenhum embedding nem escrita no índice acontece de novo.
- [ ] Given o mesmo arquivo de outro usuário, Then é processado de novo.
- [ ] Given dois envios simultâneos do mesmo arquivo, Then uma só linha e um só processamento.
- [ ] Given um PDF de 3 páginas, Then os chunks no índice têm `connectionId`, `sourceName`, `position` e `page`, e o diretório temporário é removido.
- [ ] Given Markdown e TXT, Then são indexados como texto.
- [ ] Given PDF só de imagem, Then `failed` com `NO_EXTRACTABLE_TEXT` e nenhum chunk resta.
- [ ] Given falha do Weaviate no meio, Then não restam chunks parciais e o status é `failed`; o reenvio reprocessa.
- [ ] Given a conexão do usuário A, Then o usuário B recebe `404` ao consultá-la.
- [ ] Given um anexo em processamento, Then `Send` fica desabilitado; given `Remove`, Then a conexão continua existindo.
- [ ] Given o primeiro uso, Then o aviso de privacidade aparece antes do upload e `Cancel` não envia nada.
- [ ] Given o sentinela no nome e no conteúdo, Then não aparece em log, span ou métrica, e o arquivo original não fica em disco.
- [ ] Given `bun run lint`, `check-types`, `test`, `test:integration` e `test:e2e`, Then passam sem chamar a OpenAI.

## 7. O que fazer

1. Escrever a migration de `connections` (`id`, `user_id` com `on delete cascade`, `kind`, `name`, `size_bytes`, `content_hash`, `status`, `chunk_count`, `error_code`, `created_at`, `updated_at`; unicidade de `(user_id, content_hash)`; `grant` DML ao `rondo_app`) e rodar `bun run db:migrate`.
2. Criar `modules/connections/` em camadas, com o request handler e o caso de uso por endpoint (`UploadConnection`, `GetConnection`), as portas `ConnectionRepository` e `DocumentExtractor` (um por `kind`) e o orquestrador de processamento que usa `KnowledgeIndex` e `EmbeddingsGenerator` da 0022.
3. Implementar o extrator com o `DirectoryLoader` do LangChain.js (`TextLoader`, `PDFLoader`) sobre diretório temporário exclusivo, e o divisor de texto em chunks.
4. Implementar a validação do arquivo (assinatura, tamanho, vazio, limite por usuário), o cálculo do hash em fluxo e a regra de dedup com concorrência resolvida pela unicidade do banco.
5. Implementar a compensação de falhas (remoção dos vetores parciais e do diretório temporário) e o reprocessamento de `failed`.
6. Adicionar à interface o botão flutuante, o seletor, o chip de anexo com o acompanhamento de status, o aviso de privacidade e a regra de `Send`.
7. Escrever os testes: unidade (hash, validação, chunking), integração (dedup, concorrência, falhas, isolamento entre dois usuários, diretório temporário), componente e E2E (anexar, dedup, falha, remover).
8. Atualizar `.env.example` (limites), `ARCHITECTURE.md`, `BUSINESS.md` (conectores) e `QA.md`, e registrar o ADR da ingestão de conexões (identidade por conteúdo, dedup por usuário e original não retido), conforme `RULES.md` §5.

## 8. O que não fazer

- Não confiar só na extensão ou no `Content-Type`: validar a assinatura dos bytes.
- Não guardar o arquivo original, o nome com o conteúdo ou a cópia temporária depois do processamento.
- Não logar conteúdo, nome de arquivo, hash, texto extraído ou erro com trecho do documento; mensagens de erro têm texto fixo.
- Não deduplicar entre usuários nem compartilhar chunks entre tenants.
- Não gerar embeddings nem gravar no índice quando a conexão já existe e está `ready`.
- Não deixar vetores parciais no índice após uma falha.
- Não implementar listagem, exclusão, citações, uso pelo expert nem os tipos de imagem, URL, áudio e vídeo.
- Não chamar a OpenAI nos testes automatizados.
- Não processar o arquivo dentro do request handler: ele só valida, delega ao caso de uso e responde (ADR `0014`).

## 9. Riscos e dependências

| Tipo        | Descrição                                                                                                          | Mitigação                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependência | 0019 (composer da home) e 0022 (índice e embeddings).                                                              | Implementar depois delas, com fakes das portas nos testes.                                                                                   |
| Dependência | LangChain.js (`DirectoryLoader`, `TextLoader`, `PDFLoader`) e o parser de PDF subjacente.                           | Fixar versões; isolar em `infrastructure`; o `PDFLoader` exige a dependência do parser instalada junto.                                      |
| Risco       | PDF malicioso (bomba de descompressão, arquivo gigante em páginas) esgota CPU e memória.                           | Limite de 20 MB, limite de 2.000 chunks, tempo máximo de extração (60 s) e processamento fora do request; falha vira `PROCESSING_UNAVAILABLE`. |
| Risco       | Vazamento de dados de saúde ou de contrato entre usuários.                                                         | Tenant por usuário (0022), `user_id` sempre da sessão, teste de isolamento com duas contas.                                                  |
| Risco       | Custo de embeddings por abuso (muitos arquivos ou arquivos grandes).                                               | Limite de 50 conexões por usuário, 20 MB por arquivo, limite de requisições e dedup.                                                         |
| Risco       | Processamento em memória do servidor se perde se a API cair no meio.                                               | A conexão fica `processing` sem resultado: uma `processing` com mais de 15 minutos é tratada como `failed` (R6) e o reenvio do mesmo arquivo reinicia o processamento. |
| Risco       | Entre a 0023 e a 0024 o usuário envia arquivos que o expert ainda não usa.                                         | Implementar as duas em sequência; a spec 0024 é a próxima do mapa.                                                                           |

## 10. Resultado

Como validar que a spec foi atendida:

- **Comando/verificação:** `bun run infra:up`, `bun run db:migrate`, `bun run lint`, `bun run check-types`, `bun run test`, `bun run test:integration`, `bun run test:e2e`; manualmente, anexar um PDF, um TXT e um MD, repetir o mesmo arquivo e observar o resultado.
- **Evidência esperada:** teste de integração mostrando que o segundo envio do mesmo conteúdo não chama o fake de embeddings nem o índice; teste de concorrência com uma só linha; teste de compensação sem chunks parciais; migration com unicidade `(user_id, content_hash)` e rollback no comentário.
- **Comportamento observável:** o botão flutuante anexa PDF, TXT e Markdown; o chip mostra processando, pronto ou falhou; repetir um arquivo é instantâneo e sem custo; PDFs sem texto ou protegidos dão mensagem clara.

## 11. Perguntas abertas e premissas

| Pergunta/Premissa                                                                                                                                              | Impacto                                                                  | Bloqueante? | Quem decide         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------- | ------------------- |
| **Premissa (compartilhada):** a conexão pertence ao **usuário** e vale para **todos** os experts (base por usuário); a 0024 define como a busca é restrita.      | Modelo de dados; sem vínculo expert↔conexão.                             | Não         | Produto             |
| **Premissa (compartilhada):** dedup por usuário e por conteúdo (SHA-256 dos bytes); nome não entra na identidade.                                              | Custo de embeddings e privacidade entre usuários.                        | Não         | Produto/Eng.        |
| **Premissa (compartilhada):** o arquivo original não é guardado; só chunks e metadados.                                                                        | Privacidade; não há como "baixar" ou reprocessar sem reenviar.           | Não         | Produto/Jurídico    |
| **Premissa:** limites de 20 MB por arquivo, 50 conexões por usuário, 2.000 chunks por arquivo; chunks de ~1.000 caracteres com 150 de sobreposição.             | Custo, desempenho e qualidade da busca.                                  | Não         | Produto/Eng.        |
| **Premissa:** o aviso de privacidade é lembrado no `localStorage` do navegador.                                                                                | Não há registro de aceite no servidor.                                   | Não         | Jurídico            |
| Pergunta: a LGPD exige registrar o aceite do aviso no servidor (data e versão do texto) para dados de saúde?                                                   | Nova tabela e fluxo de aceite.                                           | Não         | Jurídico            |
| Pergunta: o PDF escaneado (sem texto) precisa de OCR na primeira entrega?                                                                                      | Escopo e custo; hoje vira `failed`.                                      | Não         | Produto             |
| **Premissa:** o limite de envios é por IP (política `connection-upload`), pelo mesmo motivo da 0019: o limitador não enxerga o usuário. | Abuso de custo por contas atrás do mesmo IP. | Não | Eng. |
| **Premissa:** o E2E usa o gerador de embeddings falso (`NODE_ENV=test`, como na 0019) e o Weaviate local real. | Como testar o upload completo sem OpenAI. | Não | Eng. |

## 12. Refinamento

| Data       | O que mudou            | Motivo                                          |
| ---------- | ---------------------- | ----------------------------------------------- |
| 2026-11-17 | Spec criada (rascunho) | Quebra do épico de experts (`breakdown-specs`). |
| 2026-11-17 | R2 detalhado (limite por IP; limite de 50 só vale para conexão nova, com critério); passo 8 inclui o ADR; premissas de limite e de E2E | Auditoria: o limitador não enxerga o usuário; conflito entre o limite de 50 e a dedup; `RULES.md` §5 pede ADR |
