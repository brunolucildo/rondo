# 0030 — Política de saída de rede da API (busca de links)

- **Status:** aceito
- **Data:** 2026-11-18
- **Spec:** `.specs/0027-connections-url.md`

## Contexto

Com a spec `0027` a pessoa cola um link e **a API faz a requisição** a um endereço que ela escolheu. Isso abre o risco de **SSRF**: `http://localhost:5432`, `http://169.254.169.254/` (metadados de nuvem) ou um nome que resolve para a rede interna (Postgres, Weaviate, Grafana, Collector estão no mesmo host) fariam da API uma ponte para a rede interna. Também são riscos a bomba de descompressão e a resposta infinita (memória e CPU), o _DNS rebinding_ (o nome resolve para um IP público na validação e para `127.0.0.1` na conexão), redirecionamentos para destinos internos e o vazamento de segredos que vêm na URL (tokens na query, usuário e senha) para banco, logs, spans e métricas.

## Decisão

**Toda saída para um link passa por um único cliente protegido (`ProtectedUrlFetcher`), que valida o IP resolvido e o usa na conexão, revalida cada redirecionamento e limita tempo, tamanho e tipo; a URL completa nunca é guardada, logada ou medida.**

Detalhes:

1. **Antes de qualquer requisição:** só `http` e `https`, sem usuário e senha, porta 80 ou 443, host que não seja `localhost`, `*.localhost`, `*.local` nem `*.internal`; o parser WHATWG normaliza formas obscuras (`0x7f.1`, decimal, octal) para o IPv4 que elas são, e esse IP é conferido.
2. **IP validado e fixado:** o host é resolvido **uma vez por salto** e **todos** os endereços (A e AAAA) precisam ser públicos. IPv4: bloqueadas as faixas de uso especial (`0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, multicast e reservado). IPv6 é **lista de permissão**: só `2000::/3`, fora de `2001::/23`, `2001:db8::/32` e `3fff::/20`; `::ffff:a.b.c.d`, NAT64 (`64:ff9b::/96`) e 6to4 (`2002::/16`) valem pelo IPv4 embutido. O transporte abre o socket no IP validado (`lookup` fixado em `node:http(s)`), mantendo o nome no `Host` e no SNI do TLS (o certificado continua sendo conferido contra o nome), sem pool de conexões (`agent: false`).
3. **Redirecionamentos:** até 3, cada um passa pelas regras 1 e 2 (`http` e `https` entre si; qualquer outro esquema, porta ou destino bloqueado vira `URL_NOT_ALLOWED`; o quarto vira `TOO_MANY_REDIRECTS`).
4. **Limites:** 15 s por tentativa (DNS incluído), 5 MB **depois de descomprimir** (gzip, deflate e Brotli em _stream_; a leitura para ao exceder; `Content-Length` só adianta a recusa), tipos `text/html`, `text/plain`, `text/markdown` e `application/pdf`, 2 tentativas em falha de rede ou 5xx (nunca em 4xx nem em timeout), no máximo 4 buscas ao mesmo tempo (acima disso `503`).
5. **Segredos:** o banco guarda só o SHA-256 da URL canônica (`url_hash`) e um nome de exibição (título ou `host/caminho`, sem query nem fragmento); a API nunca devolve a URL; erros têm mensagem fixa. As requisições de saída são marcadas e **ignoradas pela instrumentação HTTP** (`ignoreOutgoingRequestHook`), que de outro modo registraria host, caminho e porta em spans e em `http.client.*`. A telemetria própria (`url_fetch.blocked`, `url_fetch.duration`, `connection.ingestions`, log `url_fetch`) usa só conjuntos fechados.
6. **Testes sem rede e sem exceção:** o cliente protegido recebe, por porta, um resolvedor de DNS e um transporte HTTP. Com `NODE_ENV=test` são os da web roteirizada em memória; a proteção continua a real. **Não existe lista de exceção para destinos internos em nenhum ambiente.**
7. **Extração:** o HTML **já baixado** vira texto pelo `HtmlToTextTransformer` do LangChain.js (que não faz rede); nenhum _loader_ ou biblioteca faz a requisição por conta própria.

## Alternativas consideradas

| Alternativa                                                  | Prós                                        | Contras                                                                                             | Por que não                                                               |
| ------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Validar a URL como texto (nome e lista de hosts)             | Simples                                     | Não vê o IP real: nomes públicos que resolvem para IP interno, _rebinding_ e formas obscuras passam | A ameaça é o IP, não o texto                                              |
| Validar o IP e deixar a biblioteca HTTP resolver de novo     | Menos código                                | Janela de _rebinding_ entre a validação e a conexão                                                 | O IP validado precisa ser o usado                                         |
| `CheerioWebBaseLoader` / `HTMLWebBaseLoader` do LangChain.js | Já existem                                  | Fazem a requisição por conta própria, fora da proteção                                              | Só o cliente protegido sai pela rede                                      |
| Proxy de saída ou rede isolada (egress gateway)              | Defesa em camadas, vale para todo o tráfego | Infra nova, fora do escopo e do ambiente local                                                      | Recomendado como reforço em produção; não substitui a validação na API    |
| Lista de permissão de domínios                               | Segurança máxima                            | Inviável para links livres do usuário                                                               | Contra o produto                                                          |
| Navegador headless para renderizar SPA                       | Cobre mais páginas                          | Executa JavaScript de terceiros dentro da infra; superfície enorme                                  | Fora do escopo (a página vira `NO_EXTRACTABLE_TEXT`)                      |
| Busca em segundo plano (como o processamento de arquivos)    | Request curto                               | A dedup por conteúdo só aconteceria depois da resposta e exigiria linha sem hash                    | A busca e a extração rodam no request; a indexação segue em segundo plano |

## Consequências

- Positivas: a API não é uma ponte para a rede interna nem para os metadados de nuvem; um link com token não deixa rastro no banco, em logs, spans nem métricas; a mesma política serve às próximas integrações de saída (os limites e o cliente são reaproveitáveis).
- Negativas: a busca ocupa o request por até ~35 s no pior caso (2 tentativas); a lista de faixas precisa ser mantida; páginas que exigem JavaScript, login ou captcha não são suportadas; não há `robots.txt` (decisão em aberto); a conversão de HTML de até 5 MB é síncrona no processo da API; ainda há um _race_ aceito: dois pedidos simultâneos do mesmo link baixam duas vezes e só um grava.
- Impacto em código, operação e time: nova dependência `html-to-text@9.0.5` (e `@types/html-to-text`); coluna `url_hash` e `kind = 'url'` em `connections` (migration `20261118140000_add_connections_url.sql`, que reconstrói o _check_ de `kind` a partir dos valores já permitidos); política `connection-url` (10 por 10 min por IP); `ignoreOutgoingRequestHook` em `observability/telemetry.ts`; recomenda-se `security-review` antes do release e, em produção, restringir a saída da API também na rede.
