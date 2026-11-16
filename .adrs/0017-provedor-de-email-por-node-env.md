# 0017 — Provedor de e-mail escolhido por `NODE_ENV`

- **Status:** aceito
- **Data:** 2026-11-16

## Contexto

O ADR `0006` escolhia o provedor por `EMAIL_PROVIDER` (`mailtrap`, `resend` ou `capture`), obrigatória, e proibia produção com outro valor que não `resend`. A variável repetia o que `NODE_ENV` já diz, permitia combinações erradas e fazia um `.env` antigo sem ela impedir a API de subir. O `capture` é usado pelos testes de integração, pelo E2E e pelo teste de carga, e `DEVELOPMENT.md` §9 proíbe teste que use rede externa.

## Decisão

O provedor é função de `NODE_ENV` (normalizado com trim e minúsculas): `production` → Resend; `test` → `capture`; qualquer outro valor → Mailtrap. `NODE_ENV` é opcional e vale `dev` quando ausente ou vazia. `EMAIL_PROVIDER` deixa de existir e, se estiver no ambiente, é ignorada. O boot registra `email_provider_selected` com o provedor e o `NODE_ENV` efetivo.

## Alternativas consideradas

| Alternativa                                       | Prós                                      | Contras                                                                                          | Por que não                                       |
| ------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Manter `EMAIL_PROVIDER`                           | Escolha explícita; falha se faltar        | Duplica `NODE_ENV`; combinações inválidas; `.env` antigo quebra                                  | Decisão do solicitante: uma variável a menos      |
| Flag separada `EMAIL_CAPTURE=true` para o capture | `NODE_ENV` só escolhe Resend ou Mailtrap  | Troca uma variável de e-mail por outra; precisa ser barrada em produção                          | `NODE_ENV=test` já existe em todo runner de teste |
| Testes usando o Mailtrap                          | Sem provedor de teste                     | Exige credencial e rede nos testes; contraria `DEVELOPMENT.md` §9; some a rota de apoio a testes | Testes não podem depender de rede externa         |
| **`NODE_ENV` escolhe o provedor**                 | Sem variável nova; produção sempre Resend | Produção sem `NODE_ENV` sobe como `dev` (Mailtrap); `test` numa API real liga o `capture`        | **Escolhida**                                     |

## Consequências

- Positivas: uma variável a menos; produção nunca usa `capture` nem Mailtrap; testes, E2E e carga seguem sem rede; `.env` antigos com `EMAIL_PROVIDER` continuam subindo.
- Negativas: produção que esqueça `NODE_ENV=production` envia ao Mailtrap sem erro (antes a API falhava no boot); em desenvolvimento, `.env` sem as credenciais do Mailtrap passa a falhar (antes só com `EMAIL_PROVIDER=mailtrap`); não há como usar o Resend fora de produção sem outro seletor.
- Impacto em código, operação e time: `parseEmailConfig` deriva o provedor; `Environment.nodeEnv` expõe o valor efetivo; `setup-env.ts`, `playwright.config.ts` e `scripts/load-test.ts` usam `NODE_ENV=test`; o ambiente de produção precisa definir `NODE_ENV=production` e `RESEND_API_KEY`; o log `email_provider_selected` mostra o provedor ativo. O token de injeção `EMAIL_PROVIDER` (`Symbol`) do módulo de e-mail não é a variável e foi mantido.
