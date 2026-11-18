# Screenshots — home de chat com os experts

Capturas do produto rodando (specs `0019` a `0029`), usadas em `.docs/HOME.md` e no `README.md`.

## Como foram capturadas

- **Ferramenta:** `e2e/docs-screenshots.spec.ts` (Playwright, Chromium). Ele **não faz parte da suíte normal**: só roda com `CAPTURE_DOCS=1`, porque envia duas mensagens e o endpoint de mensagens divide uma cota de 20 por minuto, por IP, com os demais E2E.
- **Reprodução:** `CAPTURE_DOCS=1 bunx playwright test e2e/docs-screenshots.spec.ts` (use `E2E_APP_PORT` e `E2E_API_PORT` se 5173 e 3002 estiverem ocupadas). Exige `infra:up` e `db:migrate`, como qualquer E2E.
- **O que é real:** a SPA, a API, o Postgres, o Weaviate local, os avatares, o histórico, as citações e o painel de conexões.
- **O que é roteirizado:** o texto das respostas. A API roda com `NODE_ENV=test`, em que o modelo de chat e os embeddings são falsos e determinísticos (nenhuma chamada à OpenAI); por isso as respostas dizem "this is a scripted answer".
- **Viewport:** 1280×800 (desktop) e 375×812 (`08`); animações desligadas.
- **Dados:** usuário de teste criado no banco local ("Alex Morgan", e-mail `@example.test`), removido pelo teardown do E2E; o tenant do Weaviate é apagado ao final.

## Capturas

| Arquivo                                  | O que mostra                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `01-chat-empty-light.png`                | Estado vazio: expert, persona e perguntas sugeridas                      |
| `02-expert-with-professional-notice.png` | Expert da área de saúde com o aviso de que não substitui um profissional |
| `03-attachment-ready.png`                | Arquivo conectado, chip `Ready`, antes de perguntar                      |
| `04-answer-with-sources.png`             | Resposta ancorada, com o bloco **Sources**                               |
| `05-gap-no-source.png`                   | Pergunta sem fonte: o produto declara a lacuna                           |
| `06-connections-panel.png`               | Painel **Your connections** (listar e excluir)                           |
| `07-history-after-reload-dark.png`       | A mesma conversa após recarregar, no tema escuro                         |
| `08-mobile-light.png`                    | Layout em 375 px                                                         |

O antes/depois do redesign retro 8-bit está em `../README.md` (spec `0018`).
