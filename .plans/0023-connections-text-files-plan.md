# Plano — Conexões de arquivos de texto (PDF, TXT e Markdown) com deduplicação

- **Status:** concluído (gates verdes; 3 falhas pré-existentes em `session.service.spec.ts`; commit e push no último passo)
- **Slug:** 0023-connections-text-files
- **Spec:** `.specs/0023-connections-text-files.md`
- **Data:** 2026-11-17

## Contexto

Há chat (0019) e índice vetorial por usuário (0022), mas nenhum caminho leva um documento do usuário até o índice. Esta spec entrega o upload, a identidade por conteúdo (SHA-256), a deduplicação por usuário, o pipeline de extração, chunking, embeddings e gravação, o registro no Postgres e a interface do anexo.

## Objetivo

Anexar um PDF, TXT ou MD na home vira conhecimento indexado do usuário, sem reprocessar o que já existe, com status visível (`processing`, `ready`, `failed`).

## Não-objetivos

Uso pelo expert e citações (0024); listar e excluir (0025); imagem, URL, áudio e vídeo; OCR; guardar o original; dedup entre usuários.

## Usuários e permissões

Sessão obrigatória (guard global); o `user_id` vem sempre da sessão; `GET` de conexão alheia devolve 404; tenant do Weaviate por usuário (0022).

## Fluxos e estados

Feliz: botão "Add connection" → aviso de privacidade (1ª vez) → arquivo → chip "processing" → `ready` → Send. Dedup: `200 deduplicated:true`. Erros por código no chip; `failed` reprocessa ao reenviar; `processing` há mais de 15 min vira `failed PROCESSING_UNAVAILABLE`.

## Requisitos

R1 a R10 da spec; critérios de aceite valem sem alteração.

## Contratos de dados

Tabela `connections` (`id`, `user_id` cascade, `kind` pdf|txt|md, `name`, `size_bytes`, `content_hash`, `status`, `chunk_count`, `error_code`, timestamps), unicidade `(user_id, content_hash)`. Chunks no Weaviate com `connectionId`, `sourceName`, `position`, `page`. O original não é retido.

## Integrações

LangChain.js (`DirectoryLoader`, `TextLoader`, `PDFLoader` com `pdf-parse`, `RecursiveCharacterTextSplitter`), embeddings e índice da 0022 (portas). Extração com timeout de 60 s; falha de provedor vira `PROCESSING_UNAVAILABLE`.

## Decisões e premissas

- Decisão: módulo `connections` em camadas; o loader do LangChain fica em `connections/infrastructure` e o teste de fronteira do `knowledge` passa a permitir `@langchain/*` não-weaviate ali (como já faz para `experts`).
- Decisão: o processamento roda fora do request (fila em memória com concorrência 2); o request só valida, delega e responde 202/200.
- Decisão: multipart com `FileInterceptor` (multer, já presente via `@nestjs/platform-express`) em memória, com `fileFilter` (extensão e Content-Type) antes de ler o corpo; o SHA-256 é calculado sobre o buffer (limitado a 20 MB), não em fluxo.
- Decisão: o limite de 50 conexões é checado antes do insert (a corrida entre dois arquivos diferentes pode passar de 50 em 1 ou 2; o limitador por IP contém o abuso).
- Premissa: ao enviar a mensagem, os chips concluídos são limpos (a conexão continua na base; a 0024 define o uso).
- Premissa: PDF com estrutura ilegível (cabeçalho válido, corpo corrompido) vira `NO_EXTRACTABLE_TEXT`.

## Abordagem (fatias verticais)

1. Migration + repositório + domínio (regras, validação, erros) com testes de unidade.
2. Extração e chunking (LangChain) com PDF e Markdown reais de fixture, diretório temporário.
3. Processador, `UploadConnection`, `GetConnection`, handlers, rate limit e telemetria; integração (dedup, concorrência, isolamento, compensação).
4. Interface: botão, chip, aviso de privacidade, regra do Send; testes de componente e E2E.
5. Docs, ADR, gates.

## Arquivos previstos

`db/migrations/*_create_connections.sql`, `apps/api/src/modules/connections/**`, `apps/api/src/observability/connection-telemetry.ts`, `apps/api/src/app.module.ts`, `apps/api/src/modules/rate-limit/domain/rate-limit-policy.ts`, `apps/api/src/modules/auth/index.ts`, `apps/api/src/modules/knowledge/knowledge-boundaries.spec.ts`, `apps/api/test/*`, `apps/app/src/features/connections/**`, `apps/app/src/features/experts/composer.tsx`, `e2e/connections.spec.ts`, `.env.example`, `.docs/*`, `.adrs/XXXX-0023-*.md`.

## Testes

- Unitário: hash, validação, chunking, casos de uso com fakes, processador, apresentador, telemetria, fronteiras.
- Integração: Postgres e Weaviate locais (dedup sem nova chamada ao fake, concorrência, isolamento, compensação, diretório temporário, sentinela).
- Componente e E2E: anexar, dedup, falha, remover.

## Riscos e rollback

PDF malicioso (limites de tamanho, chunks e tempo); processamento em memória perde-se se a API cair (15 min vira `failed`). Reverter: remover o módulo e a migration (rollback no comentário).

## Critério de pronto

- [x] Gates lint, tipos, build, testes unitários, integração e E2E.
- [x] ADR e docs atualizados.
- [ ] Commit e push feitos.

## Perguntas abertas

| Pergunta                                              | Impacto     | Bloqueante? | Quem decide |
| ----------------------------------------------------- | ----------- | ----------- | ----------- |
| A LGPD exige registrar o aceite do aviso no servidor? | Nova tabela | Não         | Jurídico    |
| OCR de PDF escaneado na primeira entrega?             | Escopo      | Não         | Produto     |
