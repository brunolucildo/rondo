# XXXX — Ingestão de conexões por conteúdo (provisório; o orquestrador renumera)

- **Status:** aceito
- **Data:** 2026-11-17

## Contexto

A spec `0023` leva o primeiro documento do usuário até o índice vetorial (Weaviate, tenant por usuário, spec `0022`). Os arquivos podem conter dados de saúde e contratos, o custo de embeddings cresce com cada reprocessamento e o servidor pode ser interrompido no meio de um processamento. Era preciso decidir o que identifica uma conexão, onde a deduplicação é decidida, o que fica guardado e como o processamento convive com o request.

## Decisão

Uma conexão é identificada pelo **SHA-256 dos bytes** do arquivo, **por usuário** (`unique (user_id, content_hash)` em `connections`). O servidor calcula o hash, e é o banco quem resolve a concorrência: o mesmo conteúdo reaproveita a linha (`ready` ou `processing`, `200`/`202` com `deduplicated: true`, sem extração, embeddings nem escrita no índice) e um `failed` é reivindicado por um `update ... where status = 'failed'` e reprocessado. O **arquivo original nunca é guardado**: só os chunks (Weaviate) e os metadados (Postgres). O processamento roda **fora do request**, numa fila em memória com concorrência 2 e até 20 esperando; o request só valida (extensão e tipo antes de ler o corpo, assinatura dos bytes depois), delega ao caso de uso e responde. A extração usa o `DirectoryLoader` do LangChain.js (`TextLoader` e `PDFLoader` com `pdf-parse`) sobre um diretório temporário exclusivo removido em `finally`, e o `RecursiveCharacterTextSplitter` (1.000 caracteres, 150 de sobreposição). Em qualquer falha, os vetores já gravados da conexão são removidos e a linha vira `failed` com um código fechado; uma `processing` com mais de 15 minutos é tratada como `failed` (`PROCESSING_UNAVAILABLE`) ao ser consultada ou reenviada.

## Alternativas consideradas

| Alternativa                                      | Prós                                                    | Contras                                                                                          | Por que não                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Identidade pelo nome do arquivo                  | Simples                                                 | Dois arquivos diferentes com o mesmo nome se confundem; o mesmo conteúdo com outro nome duplica  | O nome é dado do usuário e muda sem o conteúdo mudar                                         |
| Deduplicação entre usuários (hash global)        | Menos embeddings                                        | Revela que outra pessoa tem o mesmo documento e compartilha chunks entre tenants                 | Quebra o isolamento por usuário da `0022` e a privacidade                                    |
| Guardar o arquivo original (disco ou objeto)     | Permite baixar e reindexar sem reenviar                 | Mais um lugar com dados de saúde e contratos, com retenção e exclusão próprias                   | Minimiza dados pessoais; reenviar é barato por causa da deduplicação                         |
| Processar dentro do request                      | Sem fila nem status                                     | Request longo, timeout de proxy, PDF grande segura a conexão e trava o handler (ADR `0014`)      | O handler só valida e delega; o status é consultado por `GET`                                |
| Fila externa (Redis, BullMQ, tabela de jobs)     | Sobrevive a reinício e escala em várias instâncias      | Dependência e operação novas para uma instância única                                            | A recuperação por 15 minutos cobre o reinício; a fila fica atrás de `ConnectionProcessor`   |
| Loaders do LangChain no módulo `knowledge`       | Mantém o LangChain num só módulo                        | `knowledge` passa a conhecer formatos de arquivo e o ciclo de vida da conexão                    | Os loaders ficam em `connections/infrastructure`; o teste de fronteira só abre `@langchain/*` não Weaviate |

## Consequências

- Positivas: reenviar o mesmo arquivo custa uma consulta ao banco; envios simultâneos resolvem em uma linha e um processamento; nenhuma cópia do arquivo permanece em disco; nenhum vetor parcial sobrevive a uma falha; nenhum conteúdo, nome ou hash vai a log, span ou métrica.
- Negativas: duas versões de um mesmo documento (um ponto a mais) são conexões e indexações diferentes; a fila em memória perde o trabalho em andamento se a API cair (a conexão fica `processing` até os 15 minutos e o reenvio a reinicia); o arquivo inteiro (até 20 MB) fica em memória durante a validação, o hash e o processamento; o limite de 50 conexões por usuário é checado antes do insert e pode ser ultrapassado em 1 ou 2 por envios simultâneos de arquivos diferentes (o limite por IP contém o abuso).
- Impacto em código, operação e time: módulo `apps/api/src/modules/connections` (domain, application, infrastructure, interface), tabela `connections`, política de limite `connection-upload` (20 por 10 minutos por IP), telemetria `connection.ingestions` e `connection.ingestion.duration`, dependências `@langchain/classic`, `@langchain/community`, `@langchain/textsplitters` e `pdf-parse` em `apps/api` com versões exatas; `KnowledgeModule` passa a ser carregado pelo `AppModule` (a API exige `WEAVIATE_URL` e `WEAVIATE_API_KEY` ao subir). A exclusão de conexões, vetores e do registro de deduplicação é da spec `0025`.
