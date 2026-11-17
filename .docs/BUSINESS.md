# Negócio

> **Público:** qualquer pessoa que precise entender o produto antes de decidir ou codar.
> **Verificado contra o código em:** 2026-11-05. O produto ainda não foi implementado; este documento descreve intenção e vocabulário, não funcionalidades prontas.

## 1. Problema

Clubes de futebol acumulam conhecimento em ferramentas dispersas: documentos no Drive, páginas no Notion/Confluence, chamados no Jira/Linear, planilhas e PDFs. Cada função (técnico, analista, jurídico, fisiologista) precisa transformar esse acervo em decisões rápidas, mas o acesso é fragmentado e o contexto raramente chega pronto.

## 2. Proposta de valor

Uma plataforma onde o usuário configura **experts** — agentes especializados em uma função do clube — conecta as fontes de dados autorizadas e faz demandas em linguagem natural. O expert recupera o contexto relevante, analisa e entrega uma resposta **rastreável às fontes**, no formato daquela função.

O diferencial não é "um chat genérico": é ter especialização por função, fontes conectadas e respostas auditáveis.

## 3. Conceitos do domínio

| Termo                    | Definição                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Expert**               | Agente de IA configurado para atuar como uma função específica do clube. Tem escopo, fontes autorizadas e formato de entrega.   |
| **Persona**              | Termo do nome anterior do produto (`analytics-personas`, hoje **Rondo**); neste documento, o conceito operacional é **Expert**. |
| **Conector**             | Integração que traz dados de uma fonte externa (Notion, Drive, Jira etc.).                                                      |
| **Fonte**                | Documento, página, arquivo ou registro obtido por um conector.                                                                  |
| **Base de conhecimento** | Conjunto de fontes indexadas e disponíveis para um expert.                                                                      |
| **Demanda**              | Pedido feito pelo usuário a um expert.                                                                                          |
| **Entrega**              | Resposta do expert: análise, relatório, plano ou recomendação, com citações das fontes.                                         |
| **Clube**                | Organização atendida. Limite de isolamento de dados (modelo a confirmar).                                                       |
| **Área / Posição**       | Função de futebol que define o escopo do expert (ex.: Head Coach, Fisiologista).                                                |

## 4. Experts iniciais

Exemplos de configuração, não requisitos fechados:

| Expert                            | Responsabilidade                                            | Entradas típicas                                              | Saídas típicas                                                     |
| --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Head Coach Expert**             | Apoiar decisões de treino, escalação e estratégia de jogo   | Relatórios de adversário, dados de treino, elenco, calendário | Plano de treino, análise de adversário, recomendações de escalação |
| **Analista de Desempenho Expert** | Interpretar métricas individuais e coletivas                | Dados de partida/treino, scouts, vídeos e relatórios          | Análise de desempenho, comparativos, alertas                       |
| **Jurídico Esportivo Expert**     | Apoiar contratos, regulamentos e transferências             | Contratos, regulamentos de federação, normas da FIFA/CBF      | Resumo de riscos, checklist contratual, parecer                    |
| **Fisiologista Expert**           | Apoiar controle de carga, recuperação e prevenção de lesões | Dados físicos, carga de treino, histórico de lesões           | Recomendações de recuperação, alertas de sobrecarga                |

**Implementado na spec `0019` (home de chat).** O catálogo tem 7 experts fixos, definidos em código: Head Coach, Performance Analyst, Sports Lawyer, Physiologist, Sports Physician, Physiotherapist e Football Manager. Cada um tem um **personagem fictício** (nenhum é pessoa real; o Head Coach é inspirado só no estilo de um técnico veterano, sem nome, imagem ou frase de alguém real), escopo e limite explícitos e perguntas sugeridas em pt-BR. A resposta vem em streaming, no idioma da mensagem, e desde a spec `0024` é ancorada nas fontes conectadas (abaixo); a conversa de cada par (usuário, expert) é guardada no servidor (spec `0020`): reaparece ao recarregar, trocar de expert ou entrar em outro dispositivo, e a pessoa pode apagá-la em "Clear conversation". **Retenção (premissa de Produto, pendente de confirmação do Jurídico):** as mensagens ficam até a pessoa limpar a conversa, com no máximo 200 por conversa (a mais antiga sai quando entra a 201ª) e sem expiração automática; as conversas dos experts de saúde podem conter dados de saúde de atletas (LGPD), por isso o conteúdo nunca vai a log, span ou métrica e cada pessoa só enxerga as próprias conversas. Os experts de saúde e jurídico (`sports-lawyer`, `physiologist`, `sports-physician`, `physiotherapist`) mostram o aviso fixo "Informational support only. It does not replace a licensed professional." e orientam a procurar um profissional quando a pergunta exige avaliação individual. Premissas pendentes de aprovação: nomes dos personagens, perguntas sugeridas (Produto) e o texto do aviso (Jurídico).

## 5. Conectores previstos

| Categoria              | Conectores                      |
| ---------------------- | ------------------------------- |
| Gestão de conhecimento | Notion, Confluence, Google Docs |
| Arquivos               | Google Drive, PDF, Markdown     |
| Gestão de trabalho     | Jira, Linear, ClickUp           |
| Dados tabulares        | Google Sheets                   |

Requisitos mínimos para qualquer conector:

1. Autenticação e autorização explícitas do clube.
2. Ingestão idempotente e incremental (não duplicar documentos).
3. Metadados de origem preservados (título, URL, autor, data, permissões).
4. Citação da fonte na entrega do expert.
5. Revogação de acesso e remoção dos dados indexados.

**Primeiro conector entregue (spec `0023`): arquivos de texto enviados pela pessoa** (`.pdf`, `.txt` e `.md`, até 20 MB, até 50 conexões por usuário). Atende aos requisitos 2 e 3 acima: a ingestão é idempotente (o mesmo conteúdo, medido pelo SHA-256 dos bytes, não é indexado de novo, e o nome do arquivo não faz parte da identidade) e a origem (nome, tipo, página e posição do trecho) fica nos metadados. Decisões de produto: a base é **por usuário** (sem deduplicação nem compartilhamento entre usuários); o **arquivo original não é guardado**, só o texto extraído em trechos e os metadados; o conteúdo vai a um provedor de IA para gerar embeddings, por isso um aviso de privacidade aparece antes do primeiro envio (o aceite é lembrado no navegador, sem registro no servidor: se a LGPD exigir registro para dados de saúde, é uma decisão em aberto do Jurídico); PDF escaneado (sem texto) falha com mensagem clara, sem OCR. A exclusão (requisito 5) é da `0025`, abaixo.

**Gerenciar e excluir conexões (spec `0025`).** O painel "Your connections" lista o que o expert sabe sobre a pessoa e permite excluir uma conexão ou todas, com confirmação que nomeia o item (ou a quantidade) e avisa que **não há como desfazer**. Atende ao requisito 5 (remoção dos dados indexados): a exclusão remove os vetores do índice e, só depois, o registro (inclusive a identidade de deduplicação, então reenviar o mesmo arquivo o reprocessa); se o índice estiver fora do ar a exclusão falha por inteiro e pode ser repetida, sem deixar vetores órfãos. Uma conexão em processamento não pode ser excluída até terminar. **Retenção (premissa de Produto/Jurídico):** as conexões ficam até a própria pessoa excluir, sem expiração automática; o arquivo original nunca é guardado, então vetores e registro são tudo o que existe. **Histórico:** a resposta do expert permanece na conversa (é da pessoa e some em "Clear conversation"); as fontes que a citaram passam a "Source removed", sem nome nem trecho (§10). **Como atender um pedido de exclusão de titular hoje:** a pessoa usa "Delete all" e "Clear conversation" em cada expert; a exclusão da conta e a cascata completa seguem no backlog. Pergunta aberta (Jurídico): excluir uma fonte deve apagar também as respostas que a citaram?

**Respostas com fontes (spec `0024`).** A cada mensagem o expert consulta a base do usuário (todos os arquivos conectados, ou só os anexados à mensagem quando houver anexo) e responde a partir dos trechos relevantes. Atende ao requisito 4 e à regra de §10: a resposta mostra "Sources" (nome da fonte e página), montadas pelo servidor a partir do que foi recuperado, nunca do texto do modelo; sem fonte relevante o expert **declara que nenhuma fonte conectada cobre a pergunta** (aviso "No connected source covers this." na interface), não inventa dado do clube, do elenco ou de contratos e **pode** dar orientação geral marcada como "sem fonte" (premissa de Produto: se Produto exigir recusa total, muda só o prompt). O conteúdo dos documentos é tratado como dado, nunca como instrução. Para não deixar trechos de documentos no histórico depois de uma exclusão (LGPD), a citação guarda só o identificador, o nome, a página e a posição; o trecho exato não é gravado. Se a busca nas fontes falhar, o expert **não** responde em silêncio sem fonte: mostra o erro com `Try again`. Quem não tem arquivo conectado conversa como antes, sem fontes e sem aviso. Pendente (Produto): ver o trecho exato ao clicar numa fonte; calibrar o limiar de similaridade e revisar uma amostra de respostas reais antes do release (`QA.md` §1.21).

## 6. Fluxo de valor (alvo)

```text
1. Administrador conecta uma fonte e autoriza o acesso.
2. A plataforma ingere, normaliza e indexa os documentos.
3. Usuário seleciona um expert e descreve a demanda.
4. O expert recupera os trechos relevantes, analisa e responde com citações.
5. O usuário avalia a entrega e refina a demanda; o histórico fica disponível.
```

O fluxo acima é o alvo. Nenhuma etapa está implementada no repositório atual.

## 7. Escopo

### Dentro do escopo do produto

- Configuração de experts por função.
- Conexão e ingestão de fontes externas.
- Demanda em linguagem natural e entrega com citações.
- Histórico de demandas e entregas.
- Controle de acesso por clube e por expert.

### Fora do escopo desta fase

- Treinar modelo próprio.
- Substituir sistemas oficiais de federações ou clubes.
- Edição colaborativa de documentos.
- Aplicativo mobile nativo.
- Faturamento e cobrança.
- Análise em tempo real durante partidas.

## 8. Métricas de sucesso (hipóteses a validar)

| Métrica                                         | O que indica                   |
| ----------------------------------------------- | ------------------------------ |
| Tempo até a primeira resposta útil              | Velocidade de geração de valor |
| % de entregas com pelo menos uma citação válida | Rastreabilidade e confiança    |
| Taxa de conclusão da demanda                    | Se o expert resolve o problema |
| Demandas por clube por semana                   | Retenção e uso real            |
| Fontes conectadas por clube                     | Profundidade de contexto       |

## 9. Decisões em aberto

Estas decisões afetam diretamente o modelo de dados e a arquitetura. Não as assuma sem validação:

1. **Multi-tenant:** o isolamento é por clube, por usuário ou por workspace? RLS é obrigatória?
2. **Autenticação:** decidida: identidade própria na API (ADR `0007`), com Argon2id no lugar do `bcrypt` do stack original e sessão por JWT com `sid` no banco (ADR `0009`). Fica em aberto só um provedor externo (SSO) para clubes que o exijam.
3. **LLM:** provisório na spec `0019`: provedor único (OpenAI, `gpt-4o-mini`), chave só no servidor, limite por IP; multi-provedor, BYOK e limite por usuário seguem em aberto.
4. **Ingestão:** sincronização contínua, agendada ou sob demanda? Quem paga o custo de indexação?
5. **Permissões:** um expert pode acessar qualquer fonte do clube ou apenas as explicitamente vinculadas?
6. **Retenção e LGPD:** por quanto tempo documentos e conversas ficam armazenados? Como atender exclusão? Provisório na spec `0020`: conversas até a pessoa limpar, no máximo 200 mensagens por conversa, sem expiração automática (a pergunta de uma expiração, por exemplo de 90 dias, para conversas com dados de saúde segue aberta); exclusão pela própria pessoa por conversa; a exclusão de conta ainda não existe. Provisório na spec `0025`: as conexões (arquivos conectados) ficam até a pessoa excluir, individualmente ou com "Delete all"; o original nunca é guardado; excluir uma fonte mantém as respostas do histórico, cujas citações viram "Source removed" (se o Jurídico exigir apagá-las junto, é uma regra nova de cascata entre conexões e mensagens).
7. **Ordem dos conectores:** qual integração entrega valor primeiro? (Recomendação: começar por upload de PDF/Markdown e Google Drive.)
8. **Cobrança:** por clube, por assento, por volume de demandas ou por uso de LLM?

## 10. Regras de produto para o código

- Nenhuma entrega sem indicar as fontes usadas.
- Nenhum expert acessa fonte fora do escopo autorizado.
- Nenhuma resposta deve inventar dado ausente; quando faltar contexto, o expert deve declarar a lacuna.
- Histórico e citações precisam sobreviver à revogação de acesso de forma compatível com a política de retenção.
- Textos de interface, mensagens da API e e-mails em **en-US** (decisão de 2026-11-09; ver `DEVELOPMENT.md` §13). Esta documentação, as specs e os ADRs continuam em pt-BR. Internacionalização (vários idiomas) exige decisão explícita.
