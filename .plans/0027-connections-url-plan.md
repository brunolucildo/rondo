# Plano — Conexões de link (URL externa)

- **Status:** concluído (gates verdes; 3 falhas pré-existentes em `session.service.spec.ts`)
- **Slug:** 0027-connections-url
- **Spec:** `.specs/0027-connections-url.md`
- **Data:** 2026-11-17

## Contexto

Depois das 0023 a 0025 só arquivos enviados viram conhecimento. A 0027 deixa o usuário colar um link público. É o único tipo em que o servidor faz requisição a um endereço escolhido pelo usuário: o risco central é SSRF (Postgres, Weaviate, Grafana, Collector e metadados de nuvem estão na mesma rede).

## Objetivo

`POST /api/v1/connections/url` com busca protegida (IP validado e fixado, redirecionamentos revalidados, limites de tempo, tamanho e tipo), extração de HTML, PDF e texto, dedup pela URL canônica e pelo conteúdo, segredos de URL nunca guardados, campo "Link" na interface, telemetria sem URL, ADR da política de saída de rede.

## Não-objetivos

Crawl, `robots.txt`, atualização periódica, SPA, login/paywall, mídia por link, conectores com autenticação.

## Requisitos

R1 a R11 da spec, critérios sem alteração.

## Decisões e premissas (reversíveis, registradas aqui)

- **Busca e extração na própria requisição, indexação em segundo plano.** O `POST` valida, procura a URL canônica, baixa e extrai (no máximo ~35 s: 2 tentativas de 15 s) e só então grava a linha (já com o hash do conteúdo extraído, que é a identidade da 0023) e entrega ao `ConnectionProcessor` os trechos já extraídos. Assim a dedup por conteúdo devolve a conexão da primeira URL na resposta (R6) e não existe linha "sem hash".
- **Falhas da busca e da extração não criam linha.** `URL_NOT_ALLOWED`, `FETCH_FAILED`, `FETCH_TIMEOUT`, `RESPONSE_TOO_LARGE`, `UNSUPPORTED_CONTENT_TYPE`, `TOO_MANY_REDIRECTS` e `NO_EXTRACTABLE_TEXT` voltam como erro HTTP com o código; a interface mostra o chip `failed` com a mensagem do código. Reenviar repete a busca. Falhas depois da linha (`TOO_MANY_CHUNKS`, `PROCESSING_UNAVAILABLE`) são `failed` persistidas como nos arquivos; reenviar o mesmo link apaga a linha `failed` e refaz do zero (a página pode ter mudado).
- **`name` é o nome de exibição** (título da página ou `host/caminho`, sem query e sem fragmento). A migration acrescenta só `url_hash` (SHA-256 da URL canônica; único por usuário quando não nulo) e libera `kind = 'url'`.
- **Erro HTTP:** `400 INVALID_URL | URL_NOT_ALLOWED | VALIDATION_FAILED`, `409 CONNECTION_LIMIT_REACHED`, `422` para os demais códigos da busca e da extração, `503 PROCESSING_UNAVAILABLE`.
- **Fakes em `NODE_ENV=test`:** o `ProtectedUrlFetcher` real (com a proteção SSRF real) recebe um resolvedor de DNS e um transporte HTTP roteirizados; nenhuma lista de exceção para destinos internos.
- **Spans e métricas HTTP de saída:** as requisições do cliente protegido são marcadas e ignoradas pela instrumentação HTTP (`ignoreOutgoingRequestHook`), para que URL e host nunca cheguem a spans ou métricas.
- **Sem `robots.txt`**; `User-Agent` genérico `Rondo-Link-Fetcher/1.0`. Pergunta aberta da spec mantida.
- **Interface:** "Add connection" continua abrindo o seletor de arquivos; o campo "Link" vive no controle irmão "Add link" (diálogo com campo, botão desabilitado se vazio, validação ao enviar). O aviso de privacidade é o mesmo e passa a citar links.
- **Dependência nova:** `html-to-text@9.0.5` (+ `@types/html-to-text`) para o `HtmlToTextTransformer` do `@langchain/community`, que converte o HTML já baixado sem rede.

## Fatias verticais

1. **Domínio e proteção SSRF:** URL (validação, canonização, nome de exibição), classificação de IP (IPv4/IPv6), erros e portas (`UrlFetcher`, `DnsResolver`, `HttpTransport`), cliente protegido, transporte Node com IP fixado, limites; testes de unidade.
2. **Extração:** extrator de conteúdo de URL (HTML por LangChain, PDF e texto pelos extratores da 0023); testes.
3. **Caso de uso, persistência e endpoint:** migration, repositórios, `ConnectUrl`, handler, política `connection-url`, telemetria sem URL, fakes de teste; testes de unidade e integração.
4. **Interface:** "Add link", validação, mensagens por código, aviso de privacidade; testes de componente.
5. **E2E, documentação, ADR e gates.**

## Estratégia de testes

Unidade (IP, URL, limites, fetcher com resolvedor e transporte falsos, extrator, caso de uso, sentinela de segredo), integração (Postgres local: migration, `url_hash` único, dedup, apagar e refazer), componente (campo Link) e E2E (link válido, bloqueado, dedup). Nenhum teste acessa a internet nem a OpenAI.

## Riscos e rollback

SSRF: cobertura de faixas e formas obscuras, rebinding, redirecionamentos. Rollback da migration no comentário do SQL; `git revert` da branch.

## Critério de pronto

Gates `lint`, `check-types`, `build`, `test`, `test:integration`, `test:e2e` verdes (baseline: 3 falhas em `session.service.spec.ts`), ADR, docs atualizadas, commit e push.
