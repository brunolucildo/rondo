# 0020 — Weaviate com multi-tenancy por usuário e vetores calculados pela aplicação

- **Status:** aceito
- **Data:** 2026-11-17
- **Spec:** `.specs/0022-rag-weaviate-foundation.md`

## Contexto

Os experts vão responder com base em documentos que a pessoa conecta (spec 0023 em diante). Isso exige um índice vetorial para os trechos (chunks) dos documentos, e esses documentos podem trazer dados de saúde de atletas (LGPD, dado sensível). O risco principal é o vazamento entre usuários. `ARCHITECTURE.md` §7 manda que serviços externos fiquem atrás de uma porta em `infrastructure`, com timeout, retry limitado e logs sem PII. O Compose já roda Postgres e a stack Grafana, e o desenvolvimento é local (Docker no Windows).

## Decisão

1. **Weaviate** como banco vetorial, no Docker Compose, na imagem `cr.weaviate.io/semitechnologies/weaviate:1.40.5` (versão fixada, nunca `latest`), com volume `weaviate-data`, healthcheck em `/v1/.well-known/ready`, **API key** (acesso anônimo desligado) e portas HTTP 8080 e gRPC 50051 publicadas **só em `127.0.0.1`**.
   - Versão: 1.40.5 é a última estável (não candidata) publicada em 2026-11-10; a documentação vigente de instalação por Docker usa essa mesma tag (<https://docs.weaviate.io/deploy/installation-guides/docker-installation>). O client `weaviate-client` 3.15.3 (Node >= 22) e `@langchain/weaviate` 1.1.0 (que depende de `weaviate-client` ^3.13) funcionam com ela: o adaptador foi exercitado contra esse servidor (testes de integração).
   - **Sem módulos:** `ENABLE_MODULES` vazio, `DEFAULT_VECTORIZER_MODULE=none` e `API_BASED_MODULES_DISABLED=true`. A partir da 1.33 a imagem liga por padrão 45 módulos de provedores (`text2vec-openai`, `generative-*`...); desligados, `/v1/meta` lista zero módulos e o servidor não tem como chamar a OpenAI por conta própria (`ENABLE_API_BASED_MODULES` deixou de ser lido; a variável correta é `API_BASED_MODULES_DISABLED`, <https://docs.weaviate.io/weaviate/configuration/modules>).
   - Telemetria do servidor desligada (`DISABLE_TELEMETRY`).
2. **Isolamento por usuário com multi-tenancy do Weaviate:** uma coleção `KnowledgeChunk` com multi-tenancy ligada e **um tenant por usuário** (`u_<uuid sem hífens>`), criado no primeiro `upsert` e removido por `deleteAllForUser`. Nenhuma operação do adaptador recebe um tenant de fora: ele é sempre derivado do `userId` recebido. `search` e `delete*` num usuário sem tenant não fazem nada e não criam tenant. Isolamento é estrutural (o shard é do tenant), não um filtro de consulta.
3. **Vetores calculados pela aplicação** (`text-embedding-3-small`, 1.536 dimensões, `@langchain/openai`), por uma porta `EmbeddingsGenerator`. A coleção usa vetor fornecido (`selfProvided`), índice HNSW com distância cosseno e registra o modelo e a dimensão na `description`. Trocar de modelo muda a dimensão e invalida os vetores: exige reindexar (fora do escopo).
4. **Portas no domínio, adaptadores na infraestrutura** (`modules/knowledge`): `KnowledgeIndex` (`upsert`, `search`, `deleteByConnection`, `deleteAllForUser`) e `EmbeddingsGenerator`; o domínio não importa Weaviate, LangChain nem OpenAI (teste de fronteira `knowledge-boundaries.spec.ts`). Fakes em memória (`InMemoryKnowledgeIndex`, `FakeEmbeddingsGenerator`) em `modules/knowledge/testing`.
5. **Divisão entre LangChain e o client oficial:** a leitura (busca por vetor) passa pelo `WeaviateStore` de `@langchain/weaviate`; escrita, tenants e remoção usam o client oficial. Motivos: o `addVectors` do `WeaviateStore` imprime no console o resultado e os erros do lote (que podem repetir texto de chunk), o `delete` não devolve quantos objetos casaram (necessário para remover em laço além do limite de uma chamada) e ele embrulha os erros do client em `Error` de texto. Os erros de ambos viram `KnowledgeIndexUnavailableError`.
6. **Falhas:** timeout de 10 s por tentativa, até 3 tentativas com espera de 250 ms e 500 ms para conexão, timeout e 5xx (operações idempotentes: o id de cada chunk é um UUID v5 de `connectionId:position`, então regravar substitui). Chave errada e requisição recusada não são repetidas. O erro público tem mensagem fixa (`Knowledge index unavailable: <CATEGORIA>`) e nunca copia o texto do erro do client, que pode conter texto, vetor ou tenant. Embeddings: lote de 96, 20 s por chamada, 3 tentativas em 429/5xx/timeout, `EmbeddingsUnavailableError`; sem `OPENAI_API_KEY` falha sem tocar a rede.
7. **Telemetria sem conteúdo:** histograma `knowledge.index.operation.duration` (`operation`, `outcome`), histograma `knowledge.embeddings.duration` e contador `knowledge.embeddings.texts` (`outcome`), spans `knowledge.index.<operação>` e logs `knowledge_index_operation` / `knowledge_embeddings_request`, todos só com conjuntos fechados e números.
8. **Testes:** o `globalSetup` da integração continua só com o Postgres; o Weaviate é exigido apenas no `beforeAll` dos testes do módulo `knowledge`, para que os demais testes não passem a depender dele. Os testes usam a coleção `KnowledgeChunkTest` (não a do produto) e embeddings falsos; nenhum chama a OpenAI.

## Alternativas consideradas

| Alternativa | Prós | Contras | Por que não |
| ----------- | ---- | ------- | ----------- |
| `pgvector` no Postgres que já existe | Sem serviço novo; transação com os dados de conta | Sem RLS no modelo atual (ADR 0015); isolamento só por `where user_id`; ajuste de índice e memória no mesmo banco da autenticação | O isolamento seria só um filtro de consulta; a decisão de produto é um tenant por usuário |
| Weaviate com uma coleção por usuário | Isolamento forte | Cada coleção tem custo fixo alto e um limite prático baixo | Multi-tenancy existe exatamente para esse caso |
| Weaviate com uma coleção única e filtro por `userId` | Mais simples | Um erro de filtro vaza dados de saúde entre usuários | O isolamento deve ser estrutural |
| Vetorizador do Weaviate (`text2vec-openai`) | Menos código | O servidor passaria a chamar a OpenAI com a chave dele, sem timeout, retry e telemetria da aplicação; mais difícil de testar offline | A aplicação calcula os vetores atrás de uma porta |
| Só o `WeaviateStore` do LangChain | Menos código nosso | Logs com payload, `delete` sem contagem, erros sem tipo | Ver a decisão 5 |
| Qdrant, Chroma, Pinecone | Maduros | A spec 0022 fixa o Weaviate; Pinecone não roda local | Fora do escopo da decisão |

## Consequências

- Positivas: isolamento por usuário garantido pelo banco; busca local sem chamada externa além dos embeddings; contrato pequeno e testável com fake; telemetria sem PII; as specs 0023 a 0028 só dependem das portas.
- Negativas: mais um serviço no Compose (RAM; o Weaviate sobe em poucos segundos e usa algumas centenas de MB ociosos); multi-tenancy tem limite prático de tenants por nó (aceito para o volume local; revisar antes de um deploy compartilhado); `infra:up` baixa uma imagem nova; o volume `weaviate-data` é descartável (`infra:reset` o apaga) e **não há backup** (dívida registrada em `ARCHITECTURE.md` §6, como a do Postgres).
- A chave padrão de desenvolvimento (`rondo-dev-weaviate-key`) é pública e só vale no `127.0.0.1`; troque `WEAVIATE_API_KEY` antes de qualquer ambiente compartilhado.
- Impacto no código: novo módulo `apps/api/src/modules/knowledge/` (não importado pelo `AppModule` nesta spec: a 0023 o carrega), `observability/knowledge-telemetry.ts`, dependências `weaviate-client` 3.15.3, `@langchain/weaviate` 1.1.0, `@langchain/openai` 1.8.4 e `@langchain/core` 1.4.1 em `apps/api`. As imagens LGTM em `:latest` (dívida 7) continuam abertas; só o Weaviate está fixado.
- Impacto na operação: `bun run infra:up` espera o Weaviate saudável; `infra:down` preserva o volume; `infra:reset` o apaga junto com o do Postgres. Variáveis `WEAVIATE_URL`, `WEAVIATE_API_KEY` (e opcionais `WEAVIATE_GRPC_PORT`, `WEAVIATE_COLLECTION`, `OPENAI_API_KEY`) só no servidor, nunca `VITE_*`.
