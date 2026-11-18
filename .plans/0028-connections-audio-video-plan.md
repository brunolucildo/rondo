# Plano — Conexões de áudio (MP3) e vídeo (MP4) com Gemini

- **Status:** concluído (gates verdes; verificação com o Gemini real pendente)
- **Slug:** 0028-connections-audio-video
- **Spec:** `.specs/0028-connections-audio-video.md`
- **Data:** 2026-11-17

## Contexto

Depois das 0023 a 0025 a pessoa conecta PDF, TXT e Markdown. Falta áudio e vídeo (gravações de reunião, jogos), que viram texto com tempo, entram no mesmo pipeline e são citados com `mm:ss`. É a segunda integração externa do épico (Gemini, além da OpenAI) e envia voz e imagem a um terceiro.

## Objetivo

`.mp3` e `.mp4` aceitos por `POST /api/v1/connections`; o servidor valida (bytes, tamanho, duração), delega ao pipeline assíncrono, envia o arquivo à Files API do Gemini, recebe transcrição (e descrição de cenas) com marcas de tempo, divide em chunks com `startSeconds`, embeda, indexa, apaga o arquivo no provedor e marca `ready`. A citação do expert traz `startSeconds` e a interface mostra `mm:ss`.

## Não-objetivos

Geração/edição de vídeo, outros formatos, vídeo por link, quadros, reconhecimento de pessoas, guardar o original, legendas sincronizadas.

## Usuários e permissões

Sessão obrigatória; `userId` só da sessão; tudo por usuário (dedup, limites, índice). Dado sensível (voz e imagem) sai para o Gemini: aviso na interface, arquivo apagado do provedor em todo desfecho, nada de conteúdo em log/span/métrica.

## Fluxos e estados

Feliz: escolhe o arquivo, chip "Uploading" -> "Processing" ("This can take a few minutes."), polling 2 s a 15 s, `ready`, pergunta, citação `nome · mm:ss`. Erros tipados no chip. Até 2 mídias simultâneas por usuário (cliente enfileira; servidor devolve 409). Reenvio de `ready` é dedup sem Gemini.

## Requisitos

R1 a R11 da spec, critérios sem alteração.

## Contratos de dados

- `connections.kind` ganha `audio` e `video`; `duration_seconds integer null`; tabela `connection_media_usage` (livro-razão de segundos processados, janela móvel de 24 h, sobrevive à exclusão da conexão).
- Erros de upload: `MEDIA_TOO_LONG` 400, `MEDIA_UNREADABLE` 400, `TOO_MANY_PROCESSING` 409, `MEDIA_DAILY_LIMIT` 429, `MEDIA_UNAVAILABLE` 503. Falhas da conexão: `MEDIA_UNREADABLE`, `CONTENT_NOT_PROCESSABLE` (além das existentes).
- Índice: propriedade opcional `startSeconds` (int) no chunk e no hit; citação ganha `startSeconds?` só para mídia.
- `ConnectionResponse` ganha `durationSeconds: number | null`.

## Integrações

Gemini (`@google/genai` 3.4.0, só em `connections/infrastructure`): upload (Blob em memória), espera `ACTIVE`, `generateContent` (instrução fixa, saída `[mm:ss] texto`), `delete`. Timeout de 10 min por tentativa, 2 tentativas em 429/5xx/rede, exclusão em todo desfecho com varredura de pendentes. Sem chave: `503 MEDIA_UNAVAILABLE`. `NODE_ENV=test`: fake sem rede.

## Decisões e premissas

- Decisão: porta `MediaUnderstanding` no domínio; adaptador Gemini e fake na infraestrutura; extrator de mídia implementa `DocumentExtractor`.
- Decisão: a duração é lida dos metadados (ID3/cabeçalho MPEG e Xing para MP3; `moov/mvhd` para MP4) sem decodificar.
- Decisão: janela de uso diário é móvel de 24 h (premissa conservadora) e conta no aceite.
- Decisão: pista de mídia separada no processador (concorrência 3, fila 3) para não travar PDFs; `processing` de mídia é obsoleto após 30 min.
- Premissa: `GEMINI_UNDERSTANDING_MODEL` padrão `gemini-3.6-flash` (lido da documentação em 2026-11-17; o `gemini-2.5-flash` consta como descontinuado); validar com chave real.
- Dúvida em aberto (não bloqueante): Jurídico aceita enviar voz e imagem ao Gemini.

## Abordagem (fatias verticais)

1. Domínio e API de upload: kinds, regras, leitura de duração MP3/MP4, validação, erros, migration, repositórios.
2. Índice e citações: `startSeconds` no knowledge, no experts e na interface de fontes.
3. Entendimento de mídia: porta, adaptador Gemini, fake, extrator, chunker com tempo, processador com pista de mídia, limpeza.
4. Limites, módulo e telemetria: simultaneidade, cota diária, disponibilidade, métricas.
5. Interface: seletor, mensagens, fila de 2, polling, painel com duração.
6. Integração, E2E, docs, ADR e gates.

## Arquivos previstos

Ver relatório (`apps/api/src/modules/connections/**`, `knowledge/**`, `experts/domain/grounding.ts`, `db/migrations/20261118130000_*.sql`, `apps/app/src/features/connections/**`, `experts/answer-sources.tsx`, `e2e/connections-media.spec.ts`, `.docs/*`, `.adrs/0029-gemini-para-entendimento-de-midia.md`).

## Testes

- Unitário: assinaturas e duração, regras, parser e chunker de transcrição, adaptador Gemini (cliente falso), extrator, processador, casos de uso, grounding.
- Integração (Postgres e Weaviate locais, fake do Gemini): dedup sem upload, falhas tipadas, limites, cota, citação com tempo, exclusão, isolamento.
- E2E (portas 5298/3128): anexar MP3 e MP4, acompanhar, perguntar, citação `mm:ss`.
- Manual: com `GEMINI_API_KEY` real (pendência).

## Riscos e rollback

- Risco: memória (até 200 MB por mídia em memória). Mitigação: pista de mídia curta.
- Risco: modelo/ID/preço do Gemini mudam. Mitigação: variável de ambiente e adaptador isolado.
- Rollback: reverter o commit; migration com rollback manual no comentário.

## Critério de pronto

- [x] Gates lint, tipos, build, unitário (3 falhas de baseline), integração e E2E sem chamar OpenAI/Gemini.
- [x] ADR e docs atualizados.
- [ ] Verificação manual com `GEMINI_API_KEY` real (pendente).

## Perguntas abertas

| Pergunta | Impacto | Bloqueante? | Quem decide |
| -------- | ------- | ----------- | ----------- |
| Jurídico aceita voz e imagem de atletas no Gemini? | Texto do aviso | Não | Jurídico |
