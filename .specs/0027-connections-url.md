# 0027 — Conexões de link (URL externa)

> Spec executável. Preencha todas as seções; `TODO` é lacuna, não requisito.
> Use `create-spec` para criar, `refine-spec` para auditar e `implement-me` para executar.

- **Status:** pronta
- **Slug:** 0027-connections-url
- **Data:** 2026-11-17
- **Atualizado em:** 2026-11-17
- **Owner:** Produto (limites e textos); Engenharia (execução e segurança de rede)
- **Relacionados:** mapa `.plans/experts-breakdown.md` (fase 2); specs `0023` (pipeline, dedup e porta de extrator), `0024`, `0025`, `0022`; `.docs/ARCHITECTURE.md` §7 (toda integração externa tem timeout, retry limitado e logs sem PII); `.docs/DEVELOPMENT.md` §7. **Depende de:** 0023, 0024, 0025. **Destrava:** nenhuma spec.

## 1. Escopo

### Dentro do escopo

- `POST /api/v1/connections/url` (JSON `{ "url": "..." }`): cria uma conexão a partir de um **link externo** público. A interface ganha um campo "Link" no fluxo "Add connection".
- **Busca segura da página** (proteção contra SSRF): só `http` e `https`, portas 80 e 443, sem credenciais na URL, **resolução do DNS validada** contra faixas privadas, de loopback, link-local (inclusive a de metadados de nuvem), CGNAT, multicast e reservadas (IPv4 e IPv6), **IP validado e fixado na conexão** (contra DNS rebinding) e **cada redirecionamento revalidado** (até 3).
- Tipos aceitos: `text/html`, `text/plain`, `text/markdown` e `application/pdf`; corpo até 5 MB; timeout de 15 s; até 2 tentativas em falha de rede ou 5xx.
- **Extração:** HTML vira texto legível (sem menu, scripts e estilos) por loader do LangChain.js sobre o conteúdo **já baixado**; PDF e texto reaproveitam os extratores da 0023; depois, chunking, embeddings e índice como nas demais conexões.
- **Dedup em duas camadas:** pela **URL canônica** (sem baixar de novo) e pelo **hash do conteúdo extraído** (URLs diferentes com o mesmo conteúdo).
- Segredos em URL: **a query string e o fragmento nunca são guardados, logados nem exibidos**; o nome da conexão é o título da página ou `host/caminho`.
- Falhas tipadas, telemetria sem conteúdo, `ARCHITECTURE.md`, `BUSINESS.md`, `QA.md` e **ADR** (política de saída de rede da API).

### Fora do escopo

- Pipeline, upload de arquivos e chip: **0023**; busca e citações: **0024**; listar e excluir: **0025**.
- Páginas que exigem login, paywall, JavaScript para renderizar (SPA) ou captcha: não suportadas (viram `NO_EXTRACTABLE_TEXT`).
- Rastrear (crawl) o site, seguir links internos, sitemap, RSS e **atualização periódica** da página: backlog (a conexão é um retrato do momento).
- YouTube e outras plataformas de vídeo por link, e links de Google Drive, Notion ou Confluence (conectores com autenticação): backlog.
- Respeitar `robots.txt`: decisão em aberto (ver §11).
- Imagens, áudio e vídeo por link (a URL aponta para um arquivo de mídia): backlog; aqui só texto, HTML e PDF. Mídia por **upload** é da **0026** e da **0028**.

## 2. Contexto

**Estado atual.** Depois das 0023 a 0025 só arquivos enviados viram conhecimento. O pedido lista "link de URL externa" entre as conexões: regulamentos, notícias e relatórios de adversário costumam estar em páginas públicas.

**Por que é uma spec própria.** É o único tipo em que **o servidor faz requisições a endereços escolhidos pelo usuário**. Isso abre o risco de **SSRF**: o usuário informa `http://localhost:5432`, `http://169.254.169.254/` ou um nome que resolve para a rede interna (Postgres, Weaviate, Grafana e o Collector estão no mesmo host) e usa a API como ponte. A proteção é o centro da spec.

**Identidade da conexão.** A URL canônica evita baixar de novo o mesmo link. O hash do conteúdo extraído evita indexar o mesmo texto vindo de URLs distintas. Não há atualização automática: se a página mudou, o usuário exclui e adiciona de novo.

## 3. Necessidade de negócio

| Item                     | Descrição                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Usuário/papel afetado    | Pessoa autenticada com material público na web (regulamento, notícia, relatório).                      |
| Decisão ou ação que muda | Cola o link em vez de copiar o texto; o expert consulta e cita a página.                              |
| Resultado esperado       | Páginas públicas viram conhecimento indexado, com dedup, exclusão e citação, sem abrir a rede interna. |
| Métrica de sucesso       | % de links que chegam a `ready`; 0 requisições a faixas bloqueadas; falhas por código; reaproveitamento por dedup. |

## 4. Requisitos

| ID  | Requisito                                                                                                                                                                                                                                                                                                                                         | Prioridade | Critério de aceite                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `POST /api/v1/connections/url` exige sessão e tem limite de requisições **por IP** (política `connection-url` do mecanismo da ADR `0005`; premissa: 10 por 10 minutos); valida a URL (até 2.048 caracteres, esquema `http` ou `https`, host presente, **sem usuário e senha**, porta 80, 443 ou omitida) e o limite de 50 conexões por usuário.                                                                                          | Must       | Given `ftp://x`, `file:///etc/passwd`, `http://user:pw@host` ou `http://host:5432`, Then `400 INVALID_URL`. Given 2.049 caracteres, Then `400 VALIDATION_FAILED`. Given sem sessão, Then 401. Given a 51ª conexão, Then `409 CONNECTION_LIMIT_REACHED`.                                                          |
| R2  | **Bloqueio de destinos internos:** o host é resolvido pelo servidor e **todos** os IPs resultantes são verificados; se algum cair em loopback, privado (RFC 1918 e `fc00::/7`), link-local (`169.254.0.0/16` e `fe80::/10`, inclusive metadados de nuvem), CGNAT, multicast, não especificado ou reservado (IPv4 embutido em IPv6, como `::ffff:127.0.0.1`, vale como o IPv4), a requisição **não é feita**. `localhost` e nomes que resolvem para essas faixas são bloqueados. | Must       | Given `http://localhost`, `http://127.0.0.1`, `http://[::1]`, `http://[::ffff:127.0.0.1]`, `http://10.0.0.5`, `http://192.168.1.1`, `http://169.254.169.254` e `http://0x7f.1`, Then `400 URL_NOT_ALLOWED` sem nenhuma conexão de saída (verificado por resolvedor e cliente falsos). Given um nome público que resolve para `10.0.0.5`, Then bloqueado.         |
| R3  | **Anti-rebinding e redirecionamentos:** o IP validado é o **mesmo usado na conexão** (resolução única, sem segunda consulta); cada redirecionamento (até 3) passa de novo por R1 e R2; redirecionamento para destino bloqueado, para esquema diferente ou além de 3 saltos é recusado.                                                         | Must       | Given um resolvedor que responde IP público na validação e `127.0.0.1` na conexão, Then a conexão usa o IP validado e nada vai ao loopback. Given um redirecionamento 302 para `http://169.254.169.254/`, Then `URL_NOT_ALLOWED`. Given 4 redirecionamentos, Then `TOO_MANY_REDIRECTS`.                                |
| R4  | **Limites de resposta:** timeout de 15 s no total por tentativa, corpo de até 5 MB (leitura interrompida ao exceder, inclusive com `Content-Length` ausente ou mentiroso), tipos `text/html`, `text/plain`, `text/markdown` e `application/pdf`, descompressão limitada ao mesmo teto; até 2 tentativas em falha de rede ou 5xx, nunca em 4xx.   | Must       | Given uma resposta de 6 MB, Then `RESPONSE_TOO_LARGE` e a leitura para antes de consumir tudo. Given `image/png` ou `application/zip`, Then `UNSUPPORTED_CONTENT_TYPE`. Given 404, Then `FETCH_FAILED` sem nova tentativa. Given 503 seguido de 200, Then sucesso na 2ª tentativa. Given timeout, Then `FETCH_TIMEOUT`.       |
| R5  | **Extração:** HTML vira texto legível pelo loader do LangChain.js aplicado ao conteúdo baixado (sem `script`, `style`, navegação e rodapé quando identificáveis); PDF e texto usam os extratores da 0023; o resultado segue para chunking, embeddings e índice. Página sem texto útil → `failed` com `NO_EXTRACTABLE_TEXT`.                          | Must       | Given uma página HTML com menu, script e artigo, Then só o texto do artigo chega aos chunks. Given um PDF por link, Then é extraído como na 0023. Given uma página que só tem JavaScript, Then `failed` com `NO_EXTRACTABLE_TEXT`. Given o carregador, Then ele nunca faz a requisição de rede por conta própria (teste confere que o cliente protegido é o único).   |
| R6  | **Dedup em duas camadas:** (1) a **URL canônica** (esquema e host em minúsculas, sem fragmento, sem porta padrão, `/` final normalizado, parâmetros de rastreio `utm_*` removidos e os demais ordenados) é procurada antes de qualquer requisição; achando conexão `ready` do usuário, devolve `deduplicated: true` sem baixar; (2) após extrair, o SHA-256 do texto extraído é procurado; achando, devolve a conexão existente e descarta o novo processamento. | Must       | Given o mesmo link com `#secao` e `?utm_source=x`, Then é dedup pela URL sem requisição de saída. Given duas URLs diferentes com o mesmo texto, Then a segunda devolve a conexão da primeira (`deduplicated: true`) e não grava vetores novos. Given outro usuário e o mesmo link, Then é processado de novo.                |
| R7  | **Segredos e privacidade:** a URL **completa nunca é persistida, logada ou exibida**; o banco guarda só o **hash SHA-256 da URL canônica** e um nome de exibição (título da página ou `host/caminho`, sem query e sem fragmento); a API não devolve a URL; o aviso de privacidade menciona links. Nenhum conteúdo, nome ou hash em log, span ou métrica. | Must       | Given `https://x.test/doc?token=SEGREDO#a`, When processa, Then o valor `SEGREDO` não aparece no banco, em log, span, métrica nem em resposta da API; a listagem mostra `x.test/doc` ou o título. Given o sentinela no conteúdo da página, Then não aparece em log, span ou métrica.                                         |
| R8  | **Uso e ciclo de vida:** a conexão aparece na listagem (0025) com `kind: url`, pode ser anexada (`connectionIds`, 0024), é citada pelo nome de exibição e é excluída por completo; o conteúdo da página é tratado como dado (bloco delimitado da 0024).                                                                                      | Must       | Given um link `ready`, When pergunta sobre o conteúdo com ele anexado, Then a resposta cita o nome de exibição. When exclui, Then a busca deixa de achá-lo e a citação vira "Source removed". Given uma página com "ignore as instruções", Then a persona e os limites continuam valendo.                                |
| R9  | **Interface:** o fluxo "Add connection" ganha o campo "Link" com validação ao enviar e o mesmo chip de estado da 0023; mensagens por código em en-US (`INVALID_URL`, `URL_NOT_ALLOWED`, `FETCH_TIMEOUT`, `RESPONSE_TOO_LARGE`, `UNSUPPORTED_CONTENT_TYPE`, `NO_EXTRACTABLE_TEXT`); teclado e leitor de tela.                             | Must       | Given um link inválido, Then a mensagem aparece junto do campo, sem perder o texto. Given um link bloqueado, Then o chip mostra "This link can't be used." sem revelar o motivo técnico. Axe sem violações.                                                                                                           |
| R10 | Telemetria: `connection.ingestions` com `kind=url`, contador `url_fetch_blocked_total` (`reason`: `scheme`, `port`, `credentials`, `address`, `redirect`) e histograma da busca (`outcome`); log `event: "url_fetch"` com resultado, `reason`, duração e tamanho, **sem URL, host ou conteúdo**.                                              | Should     | Given tentativas bloqueadas e bem-sucedidas, Then as séries existem com dimensões fechadas e nenhum valor contém URL, host ou conteúdo.                                                                                                                                                                              |
| R11 | Documentação e decisão: um ADR da política de saída de rede da API (destinos bloqueados, IP fixado, redirecionamentos e limites), `ARCHITECTURE.md`, `BUSINESS.md` (conectores) e `QA.md` atualizados. | Must | Given o repositório, Then existe um ADR no template de `RULES.md` §5 e os documentos descrevem o `POST /api/v1/connections/url`, os códigos de erro e a proteção contra SSRF. |

## 5. Fluxos e estados

- **Caminho feliz:** o usuário cola `https://exemplo.com/regulamento` no campo "Link"; o servidor valida, normaliza, procura a URL canônica, resolve e valida o IP, baixa (com limites), extrai o texto, procura o hash do conteúdo, divide, embeda, indexa e marca `ready`; o usuário pergunta e a resposta cita "exemplo.com/regulamento".
- **Vazio:** campo "Link" vazio → o botão de adicionar fica desabilitado.
- **Carregando:** chip com indicador e `role="status"`; `Send` desabilitado até `ready` (0023).
- **Erro:** URL inválida ou bloqueada → recusa imediata; timeout, tamanho ou tipo inválidos → `failed` com mensagem clara; sem texto útil → `NO_EXTRACTABLE_TEXT`; indisponibilidade do índice ou dos embeddings → `PROCESSING_UNAVAILABLE`.
- **Sucesso parcial:** redirecionamento seguro seguido até o fim é sucesso; redirecionamento bloqueado no meio falha o link inteiro, sem aproveitar conteúdo parcial.
- **Cancelamento/retry:** `Remove` retira o chip sem excluir a conexão; reenviar um `failed` repete a busca; reenviar um `ready` é dedup; a página mudou → excluir e adicionar de novo.

## 6. Acceptance Criteria

- [ ] Given `ftp://`, `file://`, credenciais na URL ou porta fora de 80 e 443, Then `400 INVALID_URL` sem requisição.
- [ ] Given `localhost`, IPs de loopback, privados, link-local (metadados de nuvem), CGNAT, multicast, IPv6 equivalentes e formas obscuras (`0x7f.1`, decimal), Then `URL_NOT_ALLOWED` sem conexão de saída.
- [ ] Given um nome público que resolve para IP interno, Then bloqueado; given rebinding, Then a conexão usa o IP validado.
- [ ] Given redirecionamento para destino bloqueado ou mais de 3 saltos, Then recusado.
- [ ] Given resposta de 6 MB, Then `RESPONSE_TOO_LARGE` e a leitura para cedo; given tipo não aceito, `UNSUPPORTED_CONTENT_TYPE`.
- [ ] Given 503 seguido de 200, Then sucesso; given 404, Then sem nova tentativa.
- [ ] Given uma página HTML, Then só o texto do conteúdo vai aos chunks; given só JavaScript, `NO_EXTRACTABLE_TEXT`.
- [ ] Given o mesmo link com fragmento ou `utm_*`, Then dedup pela URL sem requisição; given URLs diferentes com o mesmo texto, dedup pelo conteúdo.
- [ ] Given `?token=SEGREDO`, Then o valor não existe no banco, em log, span, métrica nem na resposta da API.
- [ ] Given a conexão `ready`, Then pode ser anexada, citada pelo nome e excluída por completo.
- [ ] Given texto malicioso na página, Then fica no bloco delimitado e a persona continua valendo.
- [ ] Given `bun run lint`, `check-types`, `test`, `test:integration` e `test:e2e`, Then passam sem tráfego real à internet nem à OpenAI.

## 7. O que fazer

1. Criar o cliente de busca protegido em `infrastructure` (resolvedor, validação de faixas, fixação do IP, redirecionamentos, limites de tempo e corpo, descompressão limitada) e a porta correspondente, com fakes para teste.
2. Implementar a normalização da URL canônica e o hash; migration que acrescenta à tabela `connections` a coluna do hash da URL (única por usuário quando não nula) e o nome de exibição.
3. Implementar o extrator de URL como mais uma implementação de `DocumentExtractor`, com o loader do LangChain.js para HTML sobre o conteúdo baixado e a reutilização dos extratores de PDF e texto.
4. Criar `POST /api/v1/connections/url` (um request handler e um caso de uso, ADR `0014`), a dedup em duas camadas e a compensação da 0023.
5. Adicionar à interface o campo "Link", a validação e as mensagens por código; atualizar o aviso de privacidade.
6. Registrar a telemetria sem URL, host ou conteúdo.
7. Escrever os testes: unidade (faixas de IP em IPv4 e IPv6, formas obscuras, canonização, limites), integração com resolvedor e servidor falsos (SSRF, rebinding, redirecionamentos, tamanho, tipos, dedup, segredos), componente e E2E (link válido, bloqueado, dedup). Em `NODE_ENV=test` o cliente de busca é um fake injetado (um servidor local seria bloqueado pela própria proteção); nenhuma lista de exceção para destinos internos existe em outro ambiente.
8. Atualizar `ARCHITECTURE.md`, `BUSINESS.md` e `QA.md` e registrar o ADR da política de saída de rede da API.

## 8. O que não fazer

- Não deixar o loader do LangChain.js (ou qualquer biblioteca) fazer a requisição por conta própria: só o cliente protegido sai pela rede.
- Não confiar em verificar a URL como texto: validar o **IP resolvido** e usá-lo na conexão.
- Não seguir redirecionamentos sem revalidar cada salto.
- Não persistir, logar, medir ou devolver a URL completa, a query, o fragmento ou o host em métricas.
- Não aceitar credenciais na URL nem portas fora de 80 e 443.
- Não baixar de novo uma URL canônica já `ready` do usuário.
- Não executar JavaScript da página nem renderizar com navegador.
- Não rastrear o site nem seguir links internos.
- Não acessar a internet nem a OpenAI nos testes automatizados.

## 9. Riscos e dependências

| Tipo        | Descrição                                                                                              | Mitigação                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Dependência | 0023, 0024 e 0025; resolvedor de DNS do sistema.                                                       | Resolvedor atrás de porta, com fake nos testes.                                                                                   |
| Risco       | **SSRF** para Postgres, Weaviate, Grafana, Collector ou metadados de nuvem.                            | R2 e R3, listas de faixas testadas em IPv4 e IPv6, formas obscuras de IP, rebinding e redirecionamentos; revisão de segurança (`security-review`) antes do release. |
| Risco       | Bomba de descompressão ou resposta infinita esgota memória e CPU.                                      | Teto de 5 MB também depois de descomprimir, timeout total, leitura em fluxo interrompida ao exceder.                              |
| Risco       | Segredos em URLs assinadas (tokens, chaves) vazam para banco, logs ou citações.                        | Só o hash da URL canônica e um nome sem query; teste com sentinela em todo o caminho.                                             |
| Risco       | A página muda ou some, e a resposta cita conteúdo desatualizado.                                       | A conexão é um retrato; mostrar a data da conexão na listagem (0025); atualização é backlog.                                      |
| Risco       | Instruções maliciosas na página (prompt injection).                                                    | Conteúdo como dado no bloco delimitado (0024), teste dedicado e avaliação com o modelo real em `QA.md`.                           |
| Risco       | Direitos autorais e termos de uso de sites ao copiar o conteúdo.                                       | Uso restrito ao usuário que conecta, sem republicação; Jurídico avalia (§11).                                                     |

## 10. Resultado

Como validar que a spec foi atendida:

- **Comando/verificação:** `bun run infra:up`, `bun run lint`, `bun run check-types`, `bun run test`, `bun run test:integration`, `bun run test:e2e`; manualmente, adicionar um link público, tentar `http://localhost:3002` e `http://169.254.169.254`, repetir o link com `#` e `?utm_source=x`, perguntar sobre a página e excluir.
- **Evidência esperada:** testes de SSRF verdes (IPv4, IPv6, formas obscuras, rebinding, redirecionamentos); teste de segredos com sentinela; migration com rollback no comentário; ADR da política de saída de rede.
- **Comportamento observável:** links públicos viram conhecimento citável; destinos internos são recusados sem nenhuma conexão; o mesmo link, mesmo disfarçado, é reaproveitado.

## 11. Perguntas abertas e premissas

| Pergunta/Premissa                                                                                                                         | Impacto                                          | Bloqueante? | Quem decide        |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------- | ------------------ |
| **Premissa (compartilhada):** dedup por usuário; original não guardado; base do usuário para todos os experts.                              | Mesmas regras da 0023.                           | Não         | Produto            |
| **Premissa:** a conexão é um retrato do momento, sem atualização automática.                                                              | Frescor das fontes.                              | Não         | Produto            |
| **Premissa:** só portas 80 e 443, até 3 redirecionamentos, 5 MB e 15 s.                                                                   | Compatibilidade com sites e segurança.           | Não         | Eng./Produto       |
| Pergunta: o servidor deve respeitar `robots.txt` e se identificar com um `User-Agent` próprio?                                            | Conformidade e bloqueios por sites.              | Não         | Produto/Jurídico   |
| Pergunta: há restrição jurídica para guardar o texto de páginas de terceiros (direitos autorais) na base do usuário?                       | Texto do aviso e retenção.                       | Não         | Jurídico           |
| **Premissa:** o limite de envios de links é por IP (política `connection-url`), pelo mesmo motivo da 0019. | Abuso de busca de saída por contas atrás do mesmo IP. | Não | Eng. |
| **Premissa:** nos testes (`NODE_ENV=test`) o cliente de busca é um fake injetado; o E2E nunca acessa a internet nem um servidor local pelo cliente real. | Testar o caminho feliz sem enfraquecer a proteção SSRF. | Não | Eng. |

## 12. Refinamento

| Data       | O que mudou            | Motivo                                                  |
| ---------- | ---------------------- | ------------------------------------------------------- |
| 2026-11-17 | Spec criada (rascunho) | Fase 2 do épico de experts (`breakdown-specs`).         |
| 2026-11-17 | R1 (limite por IP), R2 (IPv4 embutido em IPv6) e critério ajustados; R11 (ADR e documentação, Must) acrescentado a partir do escopo; passo 7 define o fake de busca nos testes; premissas | Auditoria: o limitador não enxerga o usuário; faltava a forma `::ffff:`; o ADR estava só no escopo, sem requisito; testes de caminho feliz esbarrariam na própria proteção SSRF |
