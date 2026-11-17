# 0028 — Conexões de áudio (MP3) e vídeo (MP4) com Gemini

> Spec executável. Preencha todas as seções; `TODO` é lacuna, não requisito.
> Use `create-spec` para criar, `refine-spec` para auditar e `implement-me` para executar.

- **Status:** pronta
- **Slug:** 0028-connections-audio-video
- **Data:** 2026-11-17
- **Atualizado em:** 2026-11-17
- **Owner:** Produto (limites, custo e textos); Time de engenharia (execução)
- **Relacionados:** mapa `.plans/experts-breakdown.md` (fase 2); specs `0023` (pipeline, dedup, porta de extrator e chip), `0024` (busca e citações), `0025` (listar e excluir), `0022` (índice e embeddings); `.docs/ARCHITECTURE.md` §7; documentação do Gemini API sobre entendimento de vídeo e áudio. **Depende de:** 0023, 0024, 0025. **Destrava:** nenhuma spec.

## 1. Escopo

### Dentro do escopo

- Aceitar `.mp3` e `.mp4` no fluxo "Add connection" da 0023 (mesmo `POST /api/v1/connections`, mesmo botão e chip).
- **Extrator de áudio e vídeo com um modelo Gemini de entendimento multimodal** (não o `gemini-omni-flash`, que gera e edita vídeo): o arquivo é enviado ao Gemini (Files API), que devolve uma **transcrição com marcas de tempo** do áudio e, no vídeo, também uma **descrição do que aparece** (cenas, texto na tela, placar, jogadas); o texto passa pelo chunking, embeddings e índice da 0023.
- **Processamento assíncrono de longa duração:** o `POST` responde `202` e a conexão fica `processing`; o acompanhamento é o `GET` da 0023, com espera crescente maior.
- **Citação com tempo:** a citação (0024) de áudio e vídeo carrega o instante de início do trecho (`startSeconds`) e a interface mostra `mm:ss`.
- **Limpeza no provedor:** o arquivo enviado ao Gemini é **apagado do serviço** ao fim do processamento, com sucesso ou falha.
- Limites de tamanho e duração, falhas tipadas, variável `GEMINI_API_KEY`, telemetria sem conteúdo, `ARCHITECTURE.md`, `BUSINESS.md`, `QA.md` e **ADR** (provedor Gemini para mídia).

### Fora do escopo

- Pipeline, dedup, chip, busca, citações e exclusão: **0023**, **0024**, **0025** (aqui só os acréscimos de tempo na citação e o extrator).
- **Geração ou edição de vídeo** com `gemini-omni-flash` (por exemplo, clipes nas respostas): backlog.
- Outros formatos de áudio e vídeo (WAV, M4A, AAC, MOV, WebM, MKV) e vídeo por link (YouTube): backlog; links de arquivo são da **0027** apenas para texto e PDF.
- Extração de quadros, reconhecimento de jogadores ou de rostos, rastreamento de bola e métricas táticas automáticas: backlog; **identificar pessoas pelo rosto ou pela voz é proibido** (ver §8).
- Tempo real, streaming de câmera e legendas sincronizadas no player: fora (o original não é guardado).
- Reproduzir o trecho citado: o arquivo original não é guardado.

## 2. Contexto

**Estado atual.** Depois das 0023 a 0025 (e da 0026 e 0027) entram PDF, texto, imagem e links. O pedido lista "vídeos (mp4)" e "audio (mp3)" e cita "Gemini + gemini-omni-flash" para vídeo. Conferido na documentação do Google, o `gemini-omni-flash` é um modelo de **geração e edição** de vídeo (saídas de 3 a 10 s); para **entender** vídeo e áudio usa-se um modelo Gemini de entendimento multimodal, que processa as faixas de áudio e de imagem. A decisão do épico (quiz de 2026-11-17) é usar o Gemini para ler MP4 e MP3.

**Por que é uma spec própria.** É a segunda integração externa do épico (Gemini, além da OpenAI), com arquivos grandes, processamento de minutos, custo alto e dados sensíveis saindo da máquina (voz e imagem de atletas, reuniões de comissão técnica). Exige chave própria, limpeza do arquivo no provedor e regras de custo.

**Como entra no pipeline.** Áudio e vídeo viram **texto com tempo**. Cada chunk guarda o instante de início, e a citação mostra `mm:ss`. Daí em diante nada muda: busca, lacuna, dedup (SHA-256 dos bytes) e exclusão da 0023 a 0025.

## 3. Necessidade de negócio

| Item                     | Descrição                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Usuário/papel afetado    | Pessoa autenticada com gravações (palestra, reunião, entrevista) e vídeos (jogo, treino, análise de adversário). |
| Decisão ou ação que muda | Pergunta ao expert sobre o que foi dito ou mostrado, em vez de reassistir; recebe a resposta com o instante citado. |
| Resultado esperado       | MP3 e MP4 viram texto com tempo, consultável e citável, com dedup e exclusão como as demais conexões.            |
| Métrica de sucesso       | % de mídias que chegam a `ready`; tempo de processamento por minuto de mídia; custo por minuto; reaproveitamento por dedup. |

## 4. Requisitos

| ID  | Requisito                                                                                                                                                                                                                                                                                                                                     | Prioridade | Critério de aceite                                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `POST /api/v1/connections` e o seletor da 0023 passam a aceitar `.mp3` (`kind: audio`) e `.mp4` (`kind: video`). A validação confere a **assinatura dos bytes** (MP3: `ID3` ou quadro `FF Fx`; MP4: caixa `ftyp` nos bytes 4 a 8), tamanho (MP3 até 50 MB; MP4 até 200 MB), **duração** lida dos metadados (MP3 até 60 min; MP4 até 20 min; duração que não pode ser determinada, como MP3 de bitrate variável sem cabeçalho, → `400 MEDIA_UNREADABLE`) e não vazio; o limite de 50 conexões por usuário continua e só vale quando o envio criaria uma conexão nova, como na 0023. | Must       | Given um `.wav` renomeado para `.mp3`, Then `400 UNSUPPORTED_FILE`. Given MP4 de 201 MB, Then `413 FILE_TOO_LARGE`. Given MP3 de 90 min, Then `400 MEDIA_TOO_LONG`. Given MP3 e MP4 válidos, Then `202` com o `kind` certo.                                                                                              |
| R2  | **Dedup:** vale a regra da 0023 (SHA-256 dos bytes, por usuário). Mídia `ready` do mesmo usuário devolve `deduplicated: true` **sem enviar nada ao Gemini**, sem embeddings e sem escrita no índice.                                                                                                                                         | Must       | Given o mesmo MP4 enviado duas vezes, Then o segundo envio devolve o mesmo `id` com `deduplicated: true` e o fake do Gemini não recebe upload nem chamada. Given o mesmo arquivo de outro usuário, Then é processado de novo.                                                                                             |
| R3  | **Extração pelo Gemini:** o arquivo é enviado pela Files API ao modelo de entendimento (`GEMINI_UNDERSTANDING_MODEL`, modelo da família Flash escolhido na implementação conforme a documentação vigente); a instrução fixa pede transcrição fiel com marcas de tempo (`mm:ss`) e, no vídeo, descrição do que aparece e do texto na tela; a saída vira texto com tempo, dividido em chunks que guardam `startSeconds`. | Must       | Given o fake do Gemini que devolve uma transcrição com marcas de tempo, Then os chunks existem no índice do usuário com `connectionId`, `sourceName` e `startSeconds`, a linha fica `ready` e nenhuma cópia do arquivo permanece em disco. Given o MP4, Then a descrição de cenas também está nos chunks.                  |
| R4  | **Limpeza no provedor:** o arquivo enviado ao Gemini é apagado do serviço ao fim de **qualquer** desfecho (sucesso, falha, timeout ou cancelamento); falha ao apagar é registrada (sem conteúdo) e repetida na próxima varredura de limpeza, e nunca muda o resultado da conexão.                                                                | Must       | Given o fake do Gemini, Then após sucesso e após falha o arquivo foi apagado (verificado pela chamada de exclusão). Given uma falha ao apagar, Then a conexão segue `ready` e há um evento de log de limpeza pendente repetido depois.                                                                                      |
| R5  | **Processamento longo e assíncrono:** o `POST` responde `202` com `status: processing`; cada tentativa tem timeout de 10 min; até 2 tentativas em 429, 5xx ou falha de rede; a espera de acompanhamento do chip cresce de 2 s até 15 s. Uma conexão `processing` há mais de 30 min conta como `failed` (`PROCESSING_UNAVAILABLE`). Excede-se o limite de mídias simultâneas por usuário (2) com `409 TOO_MANY_PROCESSING`. | Must       | Given um MP4 de 15 min com o fake lento, Then o `POST` responde `202` em até 2 s e o `GET` mostra `processing` até concluir. Given a 3ª mídia enquanto 2 processam, Then `409 TOO_MANY_PROCESSING`. Given 429 nas duas tentativas, Then `failed` com `PROCESSING_UNAVAILABLE`.                                            |
| R6  | **Falhas tipadas:** mídia sem fala nem conteúdo útil → `NO_EXTRACTABLE_TEXT`; arquivo corrompido ou codec não suportado → `MEDIA_UNREADABLE`; recusa de conteúdo pela política do provedor → `CONTENT_NOT_PROCESSABLE`; indisponibilidade → `PROCESSING_UNAVAILABLE`; ausência de `GEMINI_API_KEY` → `503 MEDIA_UNAVAILABLE` no `POST` (sem aceitar o arquivo). A compensação da 0023 (remover vetores parciais) vale. | Must       | Given um MP3 de silêncio, Then `failed` com `NO_EXTRACTABLE_TEXT`. Given um MP4 corrompido, Then `MEDIA_UNREADABLE`. Given a chave ausente, Then `503 MEDIA_UNAVAILABLE`, nada é gravado e o chat e os demais tipos continuam funcionando.                                                                                  |
| R7  | **Citação com tempo:** a citação (0024) de áudio e vídeo inclui `startSeconds` (JSON guardado com a mensagem); a interface mostra o nome e `mm:ss` (por exemplo, "analise.mp4 · 12:30"); citações de outros tipos não mudam. O contrato de chunks do índice (0022) ganha a propriedade opcional `startSeconds`.                              | Must       | Given uma resposta que usa o trecho de 12:30 do MP4, Then a citação traz `startSeconds: 750` e a interface mostra "12:30". Given uma resposta com PDF, Then a citação segue sem tempo. Given o índice, Then chunks antigos continuam válidos sem a propriedade.                                                              |
| R8  | **Privacidade e uso:** o aviso da 0023 passa a dizer que **áudio e vídeo** (inclusive voz e imagem de pessoas) são enviados ao provedor Gemini; nenhum conteúdo, nome, hash, transcrição ou identificador do arquivo no provedor em logs, spans ou métricas; a instrução proíbe identificar pessoas pelo rosto ou pela voz; a transcrição é dado (bloco delimitado da 0024). | Must       | Given o sentinela no nome e na fala, Then não aparece em log, span ou métrica. Given a instrução enviada ao Gemini, Then contém a proibição de identificar pessoas (verificado no fake). Given uma fala "ignore as instruções", Then fica no bloco delimitado e a persona continua.                                          |
| R9  | **Ciclo de vida:** a mídia aparece na listagem (0025) com `kind: audio` ou `video` e duração; pode ser anexada à pergunta (`connectionIds`); é excluída por completo (vetores e linha); excluir uma conexão `processing` segue a regra da 0025.                                                                                            | Must       | Given uma mídia `ready`, When exclui, Then a busca deixa de achá-la e a citação vira "Source removed". Given a listagem, Then mostra o tipo e a duração.                                                                                                                                                                  |
| R10 | **Custo e telemetria:** contador `connection.ingestions` com `kind` audio e video; histograma da duração do processamento por minuto de mídia; contador de minutos processados; log `connection_ingested` com `kind`, duração da mídia, resultado e duração do processamento, **sem conteúdo ou nome**; limite de 100 minutos de mídia processados por usuário por dia (premissa). | Should     | Given o 101º minuto do dia, Then `429 MEDIA_DAILY_LIMIT` antes de enviar ao Gemini. Given ingestões com sucesso e falha, Then as séries existem com dimensões fechadas e sem conteúdo.                                                                                                                                      |
| R11 | Documentação e decisão: um ADR do provedor Gemini para mídia (modelo de entendimento, limpeza no provedor, limites e custo), `ARCHITECTURE.md`, `BUSINESS.md`, `QA.md` e `.env.example` (`GEMINI_API_KEY`, `GEMINI_UNDERSTANDING_MODEL`, limites) atualizados. | Must | Given o repositório, Then existe um ADR no template de `RULES.md` §5 e os documentos citam o provedor, as variáveis e a regra de apagar o arquivo no provedor. |

## 5. Fluxos e estados

- **Caminho feliz:** o usuário escolhe `analise.mp4` (8 min); o chip entra em processamento; o servidor valida, calcula o hash, não acha, envia ao Gemini, aguarda, recebe transcrição e descrição com tempos, divide, embeda, indexa, apaga o arquivo no Gemini e marca `ready`; o usuário pergunta "O que o treinador disse sobre a saída de bola?" e a resposta cita "analise.mp4 · 03:42".
- **Vazio:** sem mídias, o seletor só aceita os tipos listados; o botão fica disponível mesmo sem `GEMINI_API_KEY`, e a recusa vem como `503 MEDIA_UNAVAILABLE`.
- **Carregando:** chip com indicador e mensagem "This can take a few minutes."; `Send` desabilitado até `ready`; o usuário pode continuar conversando sem anexo.
- **Erro:** formato, tamanho ou duração inválidos → mensagem no chip; sem fala, ilegível, recusa ou indisponibilidade → `failed` com mensagem clara e `Try again`; limite diário ou de processamentos simultâneos → mensagem específica.
- **Sucesso parcial:** várias mídias enviadas: até 2 processam ao mesmo tempo, as demais aguardam a vez no cliente; as que falham não bloqueiam as outras.
- **Cancelamento/retry:** `Remove` retira o chip sem excluir a conexão nem interromper o servidor; reenviar um `failed` reprocessa; reenviar um `ready` é dedup; fechar a página não interrompe o processamento.

## 6. Acceptance Criteria

- [ ] Given um `.wav` renomeado para `.mp3`, Then `400 UNSUPPORTED_FILE`; given 201 MB de MP4, `413`; given MP3 de 90 min, `400 MEDIA_TOO_LONG`.
- [ ] Given o mesmo MP4 duas vezes, Then o segundo envio é dedup e nada vai ao Gemini, aos embeddings nem ao índice.
- [ ] Given uma mídia válida, Then os chunks têm `startSeconds`, o vídeo traz a descrição de cenas e nada fica em disco.
- [ ] Given sucesso ou falha, Then o arquivo é apagado do Gemini; given falha ao apagar, Then a conexão segue `ready` e a limpeza é repetida.
- [ ] Given um MP4 longo, Then o `POST` responde `202` rápido e o `GET` acompanha até `ready`.
- [ ] Given 2 mídias processando, Then a 3ª recebe `409 TOO_MANY_PROCESSING`.
- [ ] Given silêncio, corrupção, recusa ou 429 repetido, Then `NO_EXTRACTABLE_TEXT`, `MEDIA_UNREADABLE`, `CONTENT_NOT_PROCESSABLE` e `PROCESSING_UNAVAILABLE`, sem chunks parciais.
- [ ] Given a chave do Gemini ausente, Then `503 MEDIA_UNAVAILABLE` sem gravar nada e o resto do produto funciona.
- [ ] Given uma resposta com trecho de 12:30, Then a citação traz `startSeconds: 750` e a interface mostra "12:30".
- [ ] Given o sentinela na fala e no nome, Then nenhum log, span ou métrica o contém; a instrução proíbe identificar pessoas.
- [ ] Given a exclusão, Then a busca deixa de achar a mídia e a citação vira "Source removed".
- [ ] Given `bun run lint`, `check-types`, `test`, `test:integration` e `test:e2e`, Then passam sem chamar a OpenAI nem o Gemini.

## 7. O que fazer

1. Acrescentar `audio` e `video` à validação e ao seletor da 0023 (assinatura, tamanho, duração) e atualizar o aviso de privacidade; ler a duração dos metadados do arquivo sem decodificar a mídia inteira.
2. Criar a porta de entendimento de mídia e o adaptador Gemini (Files API: envio, espera até o arquivo ficar pronto, geração, exclusão), com timeout, 2 tentativas, instruções fixas e `GEMINI_UNDERSTANDING_MODEL` configurável; fake para teste.
3. Implementar o extrator de áudio e de vídeo como implementações da porta `DocumentExtractor` da 0023, com o divisor de texto que preserva `startSeconds`.
4. Implementar o processamento assíncrono, o limite de mídias simultâneas por usuário, o limite diário de minutos, a regra de `processing` antigo e a limpeza do arquivo no provedor com varredura de pendências.
5. Acrescentar `startSeconds` ao esquema do índice (0022, propriedade opcional) e às citações (0024), com a exibição `mm:ss` na interface e a listagem com duração (0025).
6. Mapear as falhas para os códigos tipados e reaproveitar a compensação da 0023.
7. Registrar a telemetria sem conteúdo e as variáveis em `.env.example` (`GEMINI_API_KEY`, `GEMINI_UNDERSTANDING_MODEL`, limites).
8. Escrever os testes: unidade (assinaturas, duração, divisão com tempos), integração com fake do Gemini (dedup, limpeza, falhas, citação com tempo, limites, exclusão, isolamento entre dois usuários), componente e E2E (anexar MP3 e MP4, acompanhar, citar).
9. Atualizar `ARCHITECTURE.md`, `BUSINESS.md`, `QA.md` e registrar o ADR do provedor Gemini para mídia.

## 8. O que não fazer

- Não usar o `gemini-omni-flash` para ler arquivos: ele gera e edita vídeo.
- Não identificar pessoas pelo rosto ou pela voz, nem guardar biometria; a instrução ao modelo proíbe.
- Não deixar arquivos no Gemini depois do processamento; não guardar o original nem quadros.
- Não enviar ao Gemini uma mídia que já existe e está `ready`.
- Não logar conteúdo, nome, hash, transcrição nem identificadores de arquivo do provedor.
- Não processar a mídia dentro do request handler: ele só valida e delega (ADR `0014`).
- Não bloquear o chat, o expert nem os demais tipos de conexão quando o Gemini estiver indisponível ou sem chave.
- Não chamar OpenAI nem Gemini nos testes automatizados.
- Não implementar geração de vídeo, vídeo por link, extração de quadros nem métricas táticas.

## 9. Riscos e dependências

| Tipo        | Descrição                                                                                                         | Mitigação                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Dependência | 0023, 0024 e 0025; 0022 (propriedade `startSeconds`).                                                             | Implementar depois delas; fakes das portas nos testes.                                                                                    |
| Dependência | Gemini API (Files API e modelo de entendimento) e `GEMINI_API_KEY`. Modelos, limites e preços mudam com frequência. | Confirmar modelo, limites e custo em `ai.google.dev` na implementação; modelo configurável; adaptador isolado; falha tipada sem chave.     |
| Risco       | Dados sensíveis (voz e imagem de atletas, reuniões) enviados a um segundo terceiro.                               | Aviso de privacidade, exclusão completa (0025), arquivo apagado no provedor, sem armazenamento do original; Jurídico revisa o texto.       |
| Risco       | Custo alto por minuto de vídeo e abuso.                                                                           | Limites de tamanho, duração, simultaneidade e minutos por dia; dedup; telemetria de custo por minuto.                                     |
| Risco       | Arquivo no provedor permanece por falha na exclusão.                                                              | Exclusão em todo desfecho, varredura de pendências e evento de log; o provedor também expira arquivos sozinho.                            |
| Risco       | Transcrição e descrição imprecisas (sotaque, ruído, cenas rápidas) levam a citações erradas.                       | Citação com instante para o usuário conferir; Produto revisa uma amostra real em `QA.md`.                                                 |
| Risco       | Processamento perdido se a API reiniciar no meio.                                                                  | `processing` com mais de 30 min conta como `failed` (R5); o reenvio do mesmo arquivo reinicia.                                            |
| Risco       | Instruções maliciosas faladas ou escritas em tela (prompt injection).                                              | Transcrição como dado no bloco delimitado (0024), teste dedicado e avaliação com o modelo real.                                           |

## 10. Resultado

Como validar que a spec foi atendida:

- **Comando/verificação:** `bun run infra:up`, `bun run lint`, `bun run check-types`, `bun run test`, `bun run test:integration`, `bun run test:e2e`; manualmente, com `GEMINI_API_KEY` de desenvolvimento, anexar um MP3 curto e um MP4 curto, perguntar sobre o que foi dito e mostrado, conferir o `mm:ss` na citação, repetir o arquivo e excluir.
- **Evidência esperada:** testes de integração com fake do Gemini cobrindo dedup sem upload, limpeza no provedor, limites, falhas e citação com tempo; migration, se houver, com rollback no comentário; ADR do provedor; relatório de `QA.md` com respostas reais revisadas e o custo medido por minuto.
- **Comportamento observável:** áudio e vídeo viram texto com tempo, o expert os usa e cita o instante, e a exclusão remove tudo (inclusive no Gemini).

## 11. Perguntas abertas e premissas

| Pergunta/Premissa                                                                                                                                         | Impacto                                                       | Bloqueante? | Quem decide        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------- | ------------------ |
| **Premissa (compartilhada):** o Gemini de **entendimento** lê MP3 e MP4; o `gemini-omni-flash` (geração) fica no backlog.                                   | Escolha do modelo e do custo.                                 | Não         | Produto            |
| **Premissa:** o ID exato do modelo de entendimento é escolhido na implementação, entre os atuais da família Flash, e fica em `GEMINI_UNDERSTANDING_MODEL`. | Qualidade, custo e limites reais.                             | Não         | Eng.               |
| **Premissa:** MP3 até 50 MB e 60 min; MP4 até 200 MB e 20 min; 2 mídias simultâneas por usuário; 100 minutos de mídia por usuário por dia.                  | Custo e experiência.                                          | Não         | Produto            |
| **Premissa:** o chunk de áudio e vídeo guarda só o instante de início (`startSeconds`).                                                                    | Granularidade da citação.                                     | Não         | Produto            |
| Pergunta: o Jurídico aceita enviar voz e imagem de atletas ao Gemini, e o aviso atual cobre isso?                                                          | Texto do aviso e viabilidade para dados de saúde.             | Não         | Jurídico           |
| Pergunta: o Produto precisa de legendas sincronizadas ou de reproduzir o trecho citado (exigiria guardar o original)?                                      | Reverte a decisão de não guardar o arquivo.                   | Não         | Produto            |
| **Premissa:** o E2E usa o Gemini falso (`NODE_ENV=test`, como na 0019) e o limite de envios é o da 0023 (por IP, política `connection-upload`). | Como testar o fluxo sem Gemini. | Não | Eng. |

## 12. Refinamento

| Data       | O que mudou            | Motivo                                                  |
| ---------- | ---------------------- | ------------------------------------------------------- |
| 2026-11-17 | Spec criada (rascunho) | Fase 2 do épico de experts (`breakdown-specs`).         |
| 2026-11-17 | R1 (duração indeterminada → `MEDIA_UNREADABLE`; limite de 50 só para conexão nova); R11 (ADR e documentação, Must) acrescentado a partir do escopo; premissa de E2E | Auditoria: MP3 de bitrate variável não tem duração confiável; o ADR estava só no escopo, sem requisito |
