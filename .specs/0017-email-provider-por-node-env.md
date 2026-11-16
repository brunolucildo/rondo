# 0017 — Provedor de e-mail escolhido por `NODE_ENV`

> Spec executável. Preencha todas as seções; `TODO` é lacuna, não requisito.
> Use `create-spec` para criar, `refine-spec` para auditar e `implement-me` para executar.

- **Status:** concluída (pendente só o `test:e2e`, que não pôde rodar: portas 5173/3002 ocupadas)
- **Slug:** email-provider-por-node-env
- **Data:** 2026-11-16
- **Atualizado em:** 2026-11-16
- **Owner:** Solicitante (Owner do produto)
- **Relacionados:** spec `0002` (envio de e-mail), ADR `0006` (e-mail transacional via API HTTP; a parte sobre `EMAIL_PROVIDER` passa a ser substituída pelo novo ADR `0017`), spec `0014` (teste de carga usa o provedor `capture`), `.docs/ARCHITECTURE.md` §4.5, `.docs/DEVELOPMENT.md` §5 e §9, `.docs/QA.md`. **Não altera** o contrato de nenhuma spec de auth.

## 1. Escopo

### Dentro do escopo

- **Remover** a variável de ambiente `EMAIL_PROVIDER` (do código, dos testes, do `.env.example`, dos scripts e da documentação normativa).
- Passar a escolher o provedor de e-mail **só por `NODE_ENV`**:
  - `production` → **Resend** (`RESEND_API_KEY` obrigatória);
  - `test` → **capture** (provedor em memória dos testes; nada sai da máquina);
  - qualquer outro valor, inclusive o padrão `dev` → **Mailtrap** (`MAILTRAP_API_TOKEN` e `MAILTRAP_INBOX_ID` obrigatórios).
- Tornar `NODE_ENV` **opcional**: ausente (ou vazia) vale `dev`; a API não deixa de subir por falta dela.
- Ajustar a validação de boot (`parseEmailConfig`) e as mensagens de erro, que hoje citam `EMAIL_PROVIDER`.
- Trocar nos pontos que ativam o `capture` hoje (`apps/api/test/setup-env.ts`, `playwright.config.ts`, `scripts/load-test.ts`) a variável `EMAIL_PROVIDER=capture` por `NODE_ENV=test`.
- Atualizar testes unitários e de integração, `.env.example`, `.docs/ARCHITECTURE.md` §4.5, `.docs/DEVELOPMENT.md`, `.docs/QA.md`, os comentários de `load/k6/**` e anotar as specs `0002` e `0014`.
- Novo ADR `0017` registrando a decisão; marcar o ADR `0006` como parcialmente substituído.

### Fora do escopo

- `EmailService`, timeout, retry, `dispatch`, layout, logs sem PII e o formato das chamadas ao Mailtrap e ao Resend (spec `0002`): nada disso muda.
- Trocar o remetente (`EMAIL_FROM`) ou as variáveis de credencial dos provedores: seguem como estão.
- Outros usos de `NODE_ENV` na API (log, CORS, rate limit, OTel): esta spec só o usa para o e-mail.
- Variável para forçar um provedor diferente do que `NODE_ENV` define (ex.: Resend em staging, Mailtrap em produção): não existe; fica como backlog se for preciso.
- Renomear o token de injeção `EMAIL_PROVIDER` (um `Symbol` em `email.tokens.ts`, usado por `overrideProvider` nos testes): não é a variável de ambiente e não muda de comportamento.
- Deploy e configuração de produção (definir `NODE_ENV=production` no ambiente real): pré-requisito de infraestrutura, fora do repositório.

## 2. Contexto

Hoje `parseEmailConfig` exige `EMAIL_PROVIDER` (`mailtrap`, `resend` ou `capture`) e, além disso, recusa subir com `NODE_ENV=production` se o valor não for `resend`. A decisão de produto (ADR `0006`) já era "Mailtrap fora de produção, Resend em produção": a variável só repete o que `NODE_ENV` diz e abre espaço para combinações erradas e para um `.env` antigo sem ela impedir a API de subir.

O provedor `capture` é uma terceira peça: os testes de integração (`setup-env.ts`), o E2E (`playwright.config.ts`, que sobe uma API própria) e o teste de carga (`scripts/load-test.ts`) dependem dele, e `DEVELOPMENT.md` §9 proíbe teste que use rede externa. Sem `EMAIL_PROVIDER`, ele passa a ser ligado por `NODE_ENV=test` (decisão do solicitante). O Vitest já define `NODE_ENV=test`; o E2E e o teste de carga passam o valor ao processo da API.

**Estado atual relevante:** `NODE_ENV` não é lido em nenhum outro ponto da API além de `parseEmailConfig`. A rota `GET/DELETE /api/v1/test-support/emails` é protegida por `CaptureOnlyGuard` (404 fora do `capture`) e continua assim, agora porque o provedor derivado é `capture`.

## 3. Necessidade de negócio

| Item                     | Descrição                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Usuário/papel afetado    | Time de engenharia e quem opera os ambientes.                                                                                                                |
| Decisão ou ação que muda | Escolher o ambiente (`NODE_ENV`) passa a escolher o provedor; ninguém configura `EMAIL_PROVIDER`.                                                            |
| Resultado esperado       | Uma variável a menos; produção sempre no Resend, desenvolvimento no Mailtrap, testes sem rede, sem combinação inválida possível.                             |
| Métrica de sucesso       | Nenhuma ocorrência de `EMAIL_PROVIDER` como variável de ambiente no repositório (fora de históricos); testes, E2E e carga continuam verdes sem rede externa. |

## 4. Requisitos

| ID  | Requisito                                                         | Prioridade | Critério de aceite                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | O provedor é derivado de `NODE_ENV`.                              | Must       | Given `NODE_ENV=production`, When iniciar, Then o provedor é `resend`; Given `NODE_ENV=test`, Then é `capture`; Given `NODE_ENV` com qualquer outro valor (`dev`, `development`, `staging`), Then é `mailtrap`.                                                                                                                                                                                         |
| R2  | `NODE_ENV` é opcional e o padrão é `dev`.                         | Must       | Given `NODE_ENV` ausente, vazia ou só com espaços, When iniciar, Then o valor efetivo é `dev`, o provedor é `mailtrap` e a API não falha por causa da variável.                                                                                                                                                                                                                                         |
| R3  | O valor de `NODE_ENV` é normalizado antes da comparação.          | Must       | Given `NODE_ENV` com espaços ou caixa diferente (`" Production "`), When iniciar, Then é tratado como `production` (e `"TEST"` como `test`).                                                                                                                                                                                                                                                            |
| R4  | `EMAIL_PROVIDER` não existe mais e é ignorada se estiver setada.  | Must       | Given um `.env` antigo com `EMAIL_PROVIDER=qualquer-coisa`, When iniciar, Then a API sobe (ou falha só pelas regras do provedor derivado) e o valor não influencia a escolha; nenhum código, teste, script, `.env.example` ou doc normativo a usa como variável de ambiente.                                                                                                                            |
| R5  | Credenciais obrigatórias do provedor derivado, validadas no boot. | Must       | Given `NODE_ENV=production` sem `RESEND_API_KEY`, When iniciar, Then a API não sobe e o erro cita `RESEND_API_KEY`; Given `dev` sem `MAILTRAP_API_TOKEN` ou `MAILTRAP_INBOX_ID` (ou com `MAILTRAP_INBOX_ID` não numérico), Then não sobe e cita a variável; Given `test`, Then nenhuma credencial é exigida; `EMAIL_FROM` válido continua exigido nos três casos. Nenhum erro ecoa valor de credencial. |
| R6  | Produção nunca usa `capture` nem Mailtrap.                        | Must       | Given `NODE_ENV=production`, When iniciar, Then o provedor é sempre `resend` e a rota `/api/v1/test-support/emails` responde 404; não há valor de variável que ligue o `capture` em produção.                                                                                                                                                                                                           |
| R7  | Testes, E2E e carga seguem sem rede externa.                      | Must       | Given `NODE_ENV=test` (definido pelo Vitest nos testes de integração; definido por `playwright.config.ts` e `scripts/load-test.ts` na API que eles sobem), When rodar `test:integration`, `test:e2e` e o teste de carga, Then as mensagens ficam disponíveis por `getCapturedEmails`/`/api/v1/test-support/emails` e nenhuma requisição vai ao Mailtrap ou ao Resend.                                   |
| R8  | Documentação e `.env.example` refletem a regra.                   | Must       | Given `.env.example`, When abrir, Then não há `EMAIL_PROVIDER`; há `NODE_ENV` comentado como opcional (padrão `dev`) e a explicação "production → Resend, test → capture, demais → Mailtrap"; `.docs/ARCHITECTURE.md` §4.5, `DEVELOPMENT.md` e `QA.md` descrevem a mesma regra.                                                                                                                         |
| R9  | O provedor ativo aparece no log de boot.                          | Should     | Given a API iniciando, When o boot termina, Then há um log com o **nome** do provedor ativo e o valor efetivo de `NODE_ENV`, sem credencial, remetente ou destinatário. Mitiga o risco de produção subir como `dev` por esquecimento (ver §9).                                                                                                                                                          |

## 5. Fluxos e estados

- **Caminho feliz:** o operador define `NODE_ENV=production` e `RESEND_API_KEY`, `EMAIL_FROM`; a API sobe e envia pelo Resend. Em desenvolvimento, sem `NODE_ENV`, com `MAILTRAP_*` e `EMAIL_FROM`, envia pelo Mailtrap. Nos testes, `NODE_ENV=test` captura em memória.
- **Vazio:** `NODE_ENV` ausente ou vazia → `dev` (não é erro).
- **Carregando:** não se aplica (resolução no boot, sem estado de UI).
- **Erro:** credencial do provedor derivado ausente ou inválida, ou `EMAIL_FROM` inválido → a API não sobe, com mensagem que cita a variável e o provedor (sem valor secreto). `EMAIL_PROVIDER` setada **não** é erro.
- **Sucesso parcial:** não se aplica.
- **Cancelamento/retry:** não se aplica ao boot. A política de retry do envio é a da spec `0002`, inalterada.

## 6. Acceptance Criteria

- [x] Given `NODE_ENV=production` com `RESEND_API_KEY` e `EMAIL_FROM` válidos, When `parseEmailConfig`, Then `{ provider: "resend" }`; e a rota de captura responde 404. (R1, R6)
- [x] Given `NODE_ENV=test` e só `EMAIL_FROM`, When `parseEmailConfig`, Then `{ provider: "capture" }`, sem exigir credencial. (R1, R5)
- [x] Given `NODE_ENV` ausente, vazia, `dev`, `development` ou `staging` com `MAILTRAP_*` e `EMAIL_FROM` válidos, When `parseEmailConfig`, Then `{ provider: "mailtrap" }`. (R1, R2)
- [x] Given `NODE_ENV=" Production "` e `"TEST"`, When `parseEmailConfig`, Then resolve `resend` e `capture`. (R3)
- [x] Given `EMAIL_PROVIDER=capture` ou lixo no ambiente de produção, When `parseEmailConfig`, Then o provedor continua `resend`. Given `EMAIL_PROVIDER` setada em qualquer ambiente, Then não muda o provedor derivado. (R4, R6)
- [x] Given `NODE_ENV=production` sem `RESEND_API_KEY`, When `parseEmailConfig`, Then lança erro citando `RESEND_API_KEY`; Given `dev` sem `MAILTRAP_API_TOKEN`/`MAILTRAP_INBOX_ID`, Then o erro cita a variável ausente; Given `MAILTRAP_INBOX_ID=abc`, Then o erro cita a variável; nenhum erro contém o valor de uma credencial. (R5)
- [x] Given `EMAIL_FROM` inválido em qualquer ambiente, When `parseEmailConfig`, Then lança erro citando `EMAIL_FROM`. (R5)
- [x] Given o teste de integração de boot com `NODE_ENV=production` e sem `RESEND_API_KEY`, When subir o `AppModule`, Then a API não sobe e o erro cita `RESEND_API_KEY` (substitui o teste "refuses to start with EMAIL_PROVIDER=capture in production"). (R5, R6)
- [x] Given o teste de integração do módulo de e-mail com `NODE_ENV=dev` (Mailtrap), When `GET /api/v1/test-support/emails`, Then 404 no envelope de erro e nenhuma chamada a `fetch`. (R6, R7)
- [ ] Given `bun run test`, `bun run test:integration`, `bun run test:e2e` e `bun run lint`/`check-types`, When rodar, Then todos passam sem rede externa e sem `EMAIL_PROVIDER` definida em lugar nenhum. (R4, R7) **Pendente:** `test:e2e` não rodou (portas 5173/3002 ocupadas) e 3 testes de `session.service.spec.ts` falham por data, antes e depois desta spec.
- [x] Given `grep -rn EMAIL_PROVIDER` no repositório (excluindo `node_modules`, `.plans/`, `.adrs/` históricos e as specs concluídas), When executar, Then restam apenas o token de injeção `EMAIL_PROVIDER` (`Symbol`) do código e, se existir, o teste que prova que a variável é ignorada. (R4, R8)
- [x] Given `.env.example`, `.docs/ARCHITECTURE.md` §4.5, `.docs/DEVELOPMENT.md` e `.docs/QA.md`, When ler, Then descrevem a regra de `NODE_ENV` e não citam `EMAIL_PROVIDER` como variável. (R8)
- [x] Given a API iniciando em cada ambiente, When ler o log de boot, Then aparece o nome do provedor e o `NODE_ENV` efetivo, sem segredo. (R9)

## 7. O que fazer

1. Reescrever `parseEmailConfig` (`apps/api/src/modules/email/domain/email-config.ts`): derivar o provedor de `NODE_ENV` normalizado (trim, minúsculas; vazio → `dev`), remover `EMAIL_PROVIDER_NAMES`/a leitura de `EMAIL_PROVIDER` e a checagem "produção só `resend`" (agora estrutural), e trocar as mensagens por algo como `MAILTRAP_API_TOKEN is required when the e-mail provider is mailtrap (NODE_ENV is not production)`. Manter `EmailConfig` com `provider` e os mesmos campos; `createEmailProvider` e `CaptureOnlyGuard` não mudam.
2. Atualizar `email-config.spec.ts` e `environment.spec.ts` para os critérios da §6 (tabela de `NODE_ENV` → provedor, normalização, credenciais, `EMAIL_PROVIDER` ignorada).
3. `apps/api/test/setup-env.ts`: remover `EMAIL_PROVIDER ??= "capture"`; garantir `NODE_ENV` como `test` (`process.env.NODE_ENV ??= "test"`, já que o Vitest o define, mas o setup torna explícito).
4. `apps/api/test/email.int-spec.ts`: o caso "provider is mailtrap" passa a usar `NODE_ENV: "dev"` em vez de `EMAIL_PROVIDER`; trocar o teste de boot por "production sem `RESEND_API_KEY` não sobe e cita a variável". Ajustar os usos de `EMAIL_PROVIDER` nas `*-int-spec.ts` de auth apenas se algum deles for a **variável** (os `overrideProvider(EMAIL_PROVIDER)` usam o `Symbol` e ficam).
5. `playwright.config.ts` (webServer da API, `env`): trocar `EMAIL_PROVIDER: "capture"` por `NODE_ENV: "test"` e atualizar o comentário.
6. `scripts/load-test.ts`: trocar `EMAIL_PROVIDER: "capture"` por `NODE_ENV: "test"`; atualizar os comentários de `load/k6/main.js` e `load/k6/lib/scenarios.js`.
7. `.env.example`: remover `EMAIL_PROVIDER`; documentar `NODE_ENV` (opcional, padrão `dev`; `production` → Resend, `test` → capture, demais → Mailtrap), mantendo `EMAIL_FROM`, `MAILTRAP_*` e `RESEND_API_KEY` com seus comentários.
8. Log de boot do provedor ativo e de `NODE_ENV` (R9), no ponto de bootstrap já existente, usando o logger atual e sem dados pessoais.
9. Documentação: `.docs/ARCHITECTURE.md` §4.5 (linhas sobre `EMAIL_PROVIDER` e "só `resend` sobe"), `.docs/DEVELOPMENT.md` (§ de testes com e-mail) e `.docs/QA.md` (pré-requisitos do E2E e da API; **não** reescrever as evidências históricas de baseline: acrescentar uma entrada nova datada). Anotar as specs `0002` e `0014` na seção Refinamento; as demais specs de auth mantêm o texto histórico.
10. Criar `.adrs/0017-provedor-de-email-por-node-env.md` (contexto, decisão, alternativas: manter `EMAIL_PROVIDER`; flag `EMAIL_CAPTURE`; testes no Mailtrap; consequências) e marcar o ADR `0006` como parcialmente substituído (só a parte do seletor).
11. Rodar `bun run code:fix`, `bun run check-types`, `bun run test`, `bun run test:integration` e, com a infra local de pé, `bun run test:e2e`.

## 8. O que não fazer

- Não manter `EMAIL_PROVIDER` como alias, fallback ou "override": a variável deixa de existir.
- Não criar outra variável para escolher o provedor (ex.: `EMAIL_CAPTURE`).
- Não permitir `capture` ou Mailtrap com `NODE_ENV=production`.
- Não tratar `NODE_ENV` ausente como erro.
- Não mexer em `EmailService`, retry, timeout, layout ou nos provedores.
- Não escrever em log nenhuma credencial, remetente, destinatário ou valor de variável além do nome do provedor e de `NODE_ENV`.
- Não reescrever o texto histórico de specs concluídas, ADRs antigos nem evidências já registradas em `QA.md`.
- Não fazer o Mailtrap ou o Resend serem chamados em nenhum teste.

## 9. Riscos e dependências

| Tipo        | Descrição                                                                                                                                                                                            | Mitigação                                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risco       | Como `NODE_ENV` é opcional e o padrão é `dev`, um deploy de produção que esqueça `NODE_ENV=production` sobe sem erro e manda e-mail ao Mailtrap (ninguém o recebe). Antes a API falhava no boot.     | Log de boot com o provedor ativo e `NODE_ENV` (R9); documentar em `ARCHITECTURE.md` e `QA.md` que produção exige `NODE_ENV=production`; item no checklist de deploy (fora do repositório). Aceito pelo solicitante. |
| Risco       | Em desenvolvimento, `.env` sem `MAILTRAP_API_TOKEN` e `MAILTRAP_INBOX_ID` passa a falhar no boot (antes só falhava se `EMAIL_PROVIDER=mailtrap`; com `EMAIL_PROVIDER=capture` não pedia credencial). | Mensagem de erro cita a variável; `.env.example` traz os placeholders; registrar em `QA.md` como pré-requisito. Quem só quer rodar sem Mailtrap usa `NODE_ENV=test` ciente de que isso liga o `capture`.            |
| Risco       | `NODE_ENV=test` em uma API real (E2E, carga) muda o comportamento de bibliotecas que leem `NODE_ENV` (Express/Nest, ex.: stack de erro, cache de views).                                             | Hoje a API não depende disso (o E2E e a carga já rodam sem `NODE_ENV`); o E2E e o teste de carga são o gate que prova que nada quebra.                                                                              |
| Dependência | `.env` e scripts locais que ainda definem `EMAIL_PROVIDER`.                                                                                                                                          | Variável ignorada (R4); a limpeza é só cosmética.                                                                                                                                                                   |
| Dependência | Credenciais do Mailtrap e do Resend dos ambientes reais (verificação manual, spec `0002`).                                                                                                           | Fora do repositório; a verificação manual segue pendente como na `0002`.                                                                                                                                            |

## 10. Resultado

Como validar que a spec foi atendida:

- **Comando/verificação:** `bun run code:fix`, `bun run check-types`, `bun run test`, `bun run test:integration`, `bun run test:e2e` (com `bun run infra:up` e `bun run db:migrate`); `grep -rn "EMAIL_PROVIDER"` conforme §6; subir a API três vezes (`NODE_ENV` ausente com `MAILTRAP_*` falsas, `NODE_ENV=test`, `NODE_ENV=production` com `RESEND_API_KEY` falsa) e ler o log de boot.
- **Evidência esperada:** gates com código 0; testes de `parseEmailConfig` cobrindo a tabela de `NODE_ENV` → provedor; teste de boot recusando produção sem `RESEND_API_KEY`; busca sem ocorrências indevidas de `EMAIL_PROVIDER`.
- **Comportamento observável:** produção → Resend e a rota de captura em 404; dev/sem `NODE_ENV` → Mailtrap; testes e E2E capturam e-mails em memória; nenhuma variável `EMAIL_PROVIDER` pedida ou necessária.

## 11. Perguntas abertas e premissas

| Pergunta/Premissa                                                                                                                                                                                                                | Impacto                                                                                           | Bloqueante? | Quem decide |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------- | ----------- |
| **Decidido:** `NODE_ENV=test` liga o `capture` (testes de integração, E2E e carga); `production` → Resend; demais → Mailtrap.                                                                                                    | Define R1, R7.                                                                                    | Não         | Solicitante |
| **Decidido:** `NODE_ENV` é opcional; padrão `dev`.                                                                                                                                                                               | Define R2.                                                                                        | Não         | Solicitante |
| **Premissa:** o valor é normalizado (trim e minúsculas) antes de comparar; `dev` é o valor efetivo quando ausente, mas qualquer valor fora de `production` e `test` (inclusive o convencional `development`) tem o mesmo efeito. | Evita que `"Production"` ou um espaço vire Mailtrap em produção; não há lista fechada de valores. | Não         | Engenharia  |
| **Premissa:** `EMAIL_PROVIDER` setada é ignorada em silêncio (sem erro nem aviso).                                                                                                                                               | `.env` antigos continuam subindo.                                                                 | Não         | Engenharia  |
| **Premissa:** o log de boot (R9) existe como `Should` e é o único mitigador do risco de produção subir como `dev`; se o solicitante quiser falha dura, será outra decisão (exigir `NODE_ENV` explícito).                         | Segurança operacional de produção.                                                                | Não         | Solicitante |
| Existe um ambiente de staging que precise do Resend ou de produção com Mailtrap? Hoje só `production` usa o Resend.                                                                                                              | Se existir, exige outro seletor (backlog).                                                        | Não         | Solicitante |

## 12. Refinamento

| Data       | O que mudou                                                                                                                                                          | Motivo                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 2026-11-16 | Spec criada; `capture` ligado por `NODE_ENV=test` (decisão do solicitante).                                                                                          | Substituir `EMAIL_PROVIDER` por `NODE_ENV`, mantendo testes sem rede. |
| 2026-11-16 | Implementada (`implement-me`). Log de boot em `EmailModule.onModuleInit` (`email_provider_selected`); `Environment.nodeEnv`; ADR `0017`. Evidência em `QA.md` §1.15. | Executar a spec.                                                      |
