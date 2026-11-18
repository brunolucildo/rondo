# Plano — Conexões de imagem (JPG, JPEG e PNG)

- **Status:** concluído (gates verdes; 3 falhas pré-existentes em `session.service.spec.ts`; commit e push no último passo)
- **Slug:** 0026-connections-images
- **Spec:** `.specs/0026-connections-images.md`
- **Data:** 2026-11-17

## Contexto

Depois das 0023 a 0025, só PDF, TXT e Markdown viram conhecimento. Uma imagem não tem texto: o extrator a converte em texto com visão (`gpt-4o-mini`) e, daí em diante, o pipeline da 0023 (chunking, embeddings, índice), a busca e as citações da 0024 e a exclusão da 0025 valem sem mudança.

## Objetivo

Anexar um JPG, JPEG ou PNG na home vira texto pesquisável do usuário (descrição objetiva e transcrição do texto visível), com dedup por SHA-256, falhas tipadas, citação pelo nome (sem página) e exclusão completa.

## Não-objetivos

Outros formatos; imagem como entrada direta de visão na pergunta; geração de imagens; reconhecimento de pessoas (proibido); guardar o original ou miniatura; OCR dedicado; URL, áudio e vídeo (0027, 0028).

## Usuários e permissões

Sem mudança: sessão obrigatória, `user_id` da sessão, tenant por usuário, rate limit `connection-upload` por IP.

## Fluxos e estados

Os da 0023 (`processing`, `ready`, `failed`, dedup 200, retry de `failed`). Códigos novos de falha: `CONTENT_NOT_PROCESSABLE`; novos códigos de upload: `IMAGE_TOO_LARGE`.

## Requisitos

R1 a R8 da spec; critérios de aceite valem sem alteração.

## Contratos de dados

- Migration: o `check` de `connections.kind` passa a aceitar `image` (sem coluna nova).
- API: `kind: "image"`; erros `400 IMAGE_TOO_LARGE`, `413 FILE_TOO_LARGE` (10 MB para imagem), `400 UNSUPPORTED_FILE`; `errorCode` `CONTENT_NOT_PROCESSABLE`.
- Chunks no Weaviate: como as demais, `page` ausente.

## Integrações

`@langchain/openai` (já instalada, `ChatOpenAI` com `gpt-4o-mini`) por trás da porta `ImageDescriber`; sem dependência nova. Timeout 30 s por tentativa, 2 tentativas (só para indisponibilidade/429/5xx).

## Decisões e premissas

- Decisão: extração de imagem é mais uma implementação de `DocumentExtractor` (`ImageDocumentExtractor`), com a porta `ImageDescriber` (domínio) e o adaptador `LangChainImageDescriber` em `connections/infrastructure`; o fake `ScriptedImageDescriber` é selecionado por `NODE_ENV=test` (como o modelo falso dos experts e o e-mail `capture`).
- Decisão: validação de dimensões e do formato sem biblioteca: leitura do cabeçalho do PNG (IHDR) e dos marcadores SOF do JPEG; arquivo cujo cabeçalho não permite ler as dimensões é `UNSUPPORTED_FILE`. Os bytes decidem o MIME enviado à visão, não a extensão.
- Decisão: sem redimensionamento antes do envio (evita dependência nativa como `sharp`); `detail: "auto"` e os limites de 10 MB e 8.000 px contêm o custo. Reavaliar se a telemetria mostrar custo alto.
- Decisão: o limite de multipart continua 20 MB (PDF); imagem acima de 10 MB é recusada pelo caso de uso com `413 FILE_TOO_LARGE`.
- Decisão: o timeout do processador para imagem é maior (2 tentativas de 30 s + espera) que o de 60 s dos demais.
- Decisão: a visão é chamada com instrução fixa que proíbe identificar pessoas pelo rosto e trata o texto da imagem como dado; saída truncada em 4.000 caracteres; resposta vazia ou o marcador `NO_RELEVANT_CONTENT` vira `NO_EXTRACTABLE_TEXT`.
- Decisão: telemetria da visão por wrapper (`InstrumentedImageDescriber`), histograma `connection.vision.duration` com `outcome` (`success|refused|unavailable`).
- Premissa: sem `OPENAI_API_KEY` a imagem falha com `PROCESSING_UNAVAILABLE` (como os embeddings). `OPENAI_VISION_MODEL` opcional (padrão `gpt-4o-mini`).
- Premissa: a avaliação da qualidade com o modelo real fica como pendência (sem chave na execução).

## Abordagem (fatias verticais)

1. Domínio e banco: kind `image`, erros, validação de assinatura/tamanho/dimensões, migration; testes de unidade.
2. Extrator: porta, extrator, adaptador LangChain, fake, instrumentação, seleção por ambiente, timeout; testes de unidade.
3. API de ponta a ponta: mensagens do handler, telemetria, integração (dedup, falhas, citação, exclusão, injeção, sentinela, isolamento).
4. Interface: seletor, rótulos, mensagens, aviso de privacidade, painel; testes de componente e E2E.
5. Docs, ADR, gates.

## Arquivos previstos

`db/migrations/*_connections_image_kind.sql`, `apps/api/src/modules/connections/**`, `apps/api/src/observability/connection-telemetry.ts`, `apps/api/test/connections-images.int-spec.ts`, `apps/app/src/features/connections/**`, `e2e/connections-images.spec.ts`, `.env.example`, `.docs/*`, `.adrs/XXXX-0026-*.md`.

## Testes

Unitário (assinatura, dimensões, truncamento, mapeamento de falhas, retry, instrução de visão, fronteiras, prompt com injeção); integração com Postgres e Weaviate locais e visão falsa; componente e E2E (anexar PNG, dedup, falha). Nenhum chama a OpenAI.

## Riscos e rollback

Descrição "inventada" (instrução de não inferir; revisão manual em `QA.md`); dado sensível em imagem (aviso, exclusão, original não guardado). Reverter: remover o extrator e a migration (a migration restaura o `check` antigo no comentário de rollback; exige apagar antes as linhas `image`).

## Critério de pronto

- [x] Gates lint, tipos, build, testes unitários, integração e E2E.
- [x] ADR e docs atualizados (`.adrs/XXXX-0026-imagens-como-texto-por-visao.md`, número provisório).
- [ ] Commit e push feitos.

## Perguntas abertas

| Pergunta | Impacto | Bloqueante? | Quem decide |
| -------- | ------- | ----------- | ----------- |
| OCR dedicado para manuscritos ou fotos ruins? | Nova integração e custo | Não | Produto |
