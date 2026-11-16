# Plano — Provedor de e-mail escolhido por `NODE_ENV`

- **Status:** pronto para implementar
- **Slug:** 0017-email-provider-por-node-env
- **Spec:** `.specs/0017-email-provider-por-node-env.md`
- **Data:** 2026-11-16

## Contexto

`parseEmailConfig` exige `EMAIL_PROVIDER` (`mailtrap`, `resend`, `capture`) e recusa produção sem `resend`. `NODE_ENV` já diz se é produção; a variável duplica a escolha. `capture` é usado pelos testes de integração (`setup-env.ts`), pelo E2E (`playwright.config.ts`) e pelo teste de carga (`scripts/load-test.ts`).

## Objetivo

Remover `EMAIL_PROVIDER`. `NODE_ENV=production` → Resend; `test` → capture; qualquer outro valor (padrão `dev`) → Mailtrap. `NODE_ENV` opcional.

## Não-objetivos

`EmailService`, retry, timeout, layout, provedores; outros usos de `NODE_ENV`; seletor alternativo de provedor; renomear o token de injeção `EMAIL_PROVIDER` (`Symbol`).

## Usuários e permissões

Sem usuário final. A rota `/api/v1/test-support/emails` segue protegida por `CaptureOnlyGuard` (404 fora do `capture`), agora sempre 404 em produção.

## Fluxos e estados

- Feliz: `NODE_ENV` → provedor derivado → credenciais validadas no boot.
- Vazio: `NODE_ENV` ausente/vazia → `dev` → Mailtrap.
- Erro: credencial ou `EMAIL_FROM` inválidos → a API não sobe, citando a variável (sem valor). `EMAIL_PROVIDER` setada é ignorada.

## Requisitos

R1 a R9 da spec (R9 = log de boot, Should).

## Contratos de dados

`EmailConfig` mantém a forma (`provider` + campos). `Environment` ganha `nodeEnv` (valor efetivo, normalizado). Nenhuma credencial em log.

## Integrações

Mailtrap e Resend inalterados (spec 0002).

## Decisões e premissas

- Decisão (solicitante): `NODE_ENV=test` liga o `capture`; `NODE_ENV` opcional com padrão `dev`.
- Premissa: valor normalizado (trim + minúsculas); `EMAIL_PROVIDER` ignorada em silêncio.
- Premissa: o log de boot sai de `EmailModule.onModuleInit` (cobre API real e testes) via `baseLogger`.

## Abordagem

1. Reescrever `email-config.ts` (`resolveNodeEnv`, `selectEmailProvider`, `parseEmailConfig`) e seus testes.
2. `environment.ts` expõe `nodeEnv`; `environment.spec.ts` atualizado.
3. `setup-env.ts`, `email.int-spec.ts`, `playwright.config.ts`, `scripts/load-test.ts`, comentários de `load/k6`.
4. Log de boot no `EmailModule`, com teste.
5. `.env.example`, `.docs` (ARCHITECTURE §4.5, DEVELOPMENT, QA), specs 0002 e 0014, ADR 0017 e ADR 0006 parcialmente substituído.
6. Gates: format, lint, tipos, testes unitários e de integração, E2E, build.

## Arquivos previstos

- `apps/api/src/modules/email/domain/email-config.ts` (+ spec), `modules/email/index.ts`, `modules/email/email.module.ts`
- `apps/api/src/config/environment.ts` (+ spec)
- `apps/api/test/setup-env.ts`, `apps/api/test/email.int-spec.ts`
- `playwright.config.ts`, `scripts/load-test.ts`, `load/k6/main.js`, `load/k6/lib/scenarios.js`
- `.env.example`, `.docs/ARCHITECTURE.md`, `.docs/DEVELOPMENT.md`, `.docs/QA.md`
- `.specs/0002-*.md`, `.specs/0014-*.md`, `.adrs/0017-*.md`, `.adrs/0006-*.md`

## Testes

- Unitário: tabela `NODE_ENV` → provedor, normalização, credenciais, `EMAIL_PROVIDER` ignorada, sem eco de segredo.
- Integração: Mailtrap com `NODE_ENV=dev` → 404 na rota de captura; boot de produção sem `RESEND_API_KEY` falha; log de boot.
- E2E: com `NODE_ENV=test` na API (exige `infra:up` e `db:migrate`).
- Manual: subir a API com `NODE_ENV` ausente, `test` e `production` e ler o log.

## Riscos e rollback

- Risco: produção sem `NODE_ENV` sobe como `dev` (mitigado pelo log de boot e pela documentação). Rollback: reverter o commit.

## Critério de pronto

- [x] Gates passando (exceto `test:e2e`, não executado, e 3 falhas pré-existentes por data em `session.service.spec.ts`) e `EMAIL_PROVIDER` limpo no código.
- [x] Docs, ADR e specs atualizados.

## Perguntas abertas

| Pergunta            | Impacto                          | Bloqueante? | Quem decide |
| ------------------- | -------------------------------- | ----------- | ----------- |
| Staging com Resend? | Exigiria outro seletor (backlog) | Não         | Solicitante |
