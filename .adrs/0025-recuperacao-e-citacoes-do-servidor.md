# 0025 — Recuperação nas respostas dos experts e citações montadas pelo servidor

- **Status:** aceito (decisão da spec `0024`)
- **Data:** 2026-11-17

## Contexto

Depois das specs 0022 (índice vetorial por usuário) e 0023 (conexões de arquivos), o chat dos experts (0019, 0020) ainda responde só com o conhecimento do modelo. `BUSINESS.md` §10 exige indicar as fontes usadas e não inventar dado ausente, e a base contém documentos de terceiros (contratos, laudos) que podem trazer instruções escritas para enganar o modelo. A conversa persistida (0020) guarda dados que podem ser de saúde, e o usuário pode excluir uma fonte (0025). Era preciso decidir onde a recuperação acontece, quem escreve as citações, o que se grava delas, como se trata o conteúdo dos trechos e o que acontece quando a busca falha.

## Decisão

A recuperação é um nó do grafo LangGraph do expert (`START → retrieve → respond → END`) sobre duas portas do próprio `experts` (`KnowledgeRetriever`, `ConnectionSources`) implementadas sobre os ports do `knowledge` e do `connections`. O texto dos trechos vai ao modelo como dado, num bloco delimitado com os sinais `&`, `<` e `>` escapados. As citações (`connectionId`, nome, página, posição) são **montadas pelo servidor** a partir dos trechos recuperados, **sem o texto do trecho**, enviadas no stream como evento `citations` e gravadas na coluna `expert_messages.citations` (`null` = sem recuperação, `[]` = lacuna). Falha de embeddings ou do índice termina o stream com `KNOWLEDGE_UNAVAILABLE`, nunca com resposta silenciosa sem fonte.

## Alternativas consideradas

| Alternativa | Prós | Contras | Por que não |
| ----------- | ---- | ------- | ----------- |
| Pedir ao modelo que escreva as citações no texto | Nenhum código de citação | O modelo pode citar um arquivo que não existe ou deixar de citar; a "citação decorativa" parece auditável sem ser | Quebra o objetivo de rastreabilidade (`BUSINESS.md` §10); as citações vêm do que foi recuperado |
| Guardar o trecho exato na citação | A interface mostraria o trecho no histórico | Deixa conteúdo de documentos no histórico depois da exclusão da fonte (LGPD) e aumenta o volume de dados de saúde e contratos guardados | Decisão de Produto/Jurídico: a citação guarda só identificador, nome, página e posição |
| Recuperação fora do grafo (no caso de uso, antes de chamar o orquestrador) | Grafo continua de um nó; o caso de uso controla tudo | O prompt teria de ser montado fora do grafo e a spec pede o passo no grafo; as próximas specs (agente, rastros por nó) não teriam onde crescer | O grafo é o lugar do fluxo de resposta (ADR da 0019); o caso de uso só decide escopo e lê o resultado |
| Coluna separada (`has_retrieval`) para distinguir lacuna de "sem busca" | Mais explícito | Uma coluna a mais e dois campos para manter coerentes | `null` versus `[]` na própria coluna carrega a mesma informação |
| Buscar sempre, mesmo sem conexão | Código mais simples | Custo de embedding e dependência do Weaviate para quem não tem arquivo; o chat deixaria de funcionar com o Weaviate parado | Spec: sem conexão `ready` não há chamada de embeddings nem do índice |
| Remover tags do texto do trecho (em vez de escapar) | Prompt mais limpo | Altera o conteúdo e pode esconder o ataque | Escapar mantém o texto legível para o modelo e impede fechar o bloco |
| Em falha da busca, responder sem fonte | Chat sempre responde | A resposta teria aparência de ancorada sem estar; viola §10 | Falhar de forma visível com `Try again` (R8) |

## Consequências

- Positivas: toda resposta com recuperação traz fontes verificáveis ou declara a lacuna; as citações não dependem do texto do modelo; excluir uma fonte não deixa texto dela no histórico; o chat de quem não tem arquivos não depende do Weaviate; qualquer conexão nova (imagem, URL, áudio, vídeo) entra na busca sem mudar esta decisão.
- Negativas: uma busca vetorial simples (sem híbrida, reescrita nem reranking) pode produzir lacunas falsas ou fontes falsas com o limiar inicial (0,30, não calibrado com embeddings reais); mais latência antes do primeiro token (embedding da pergunta e busca); a função `expert_append_message` mudou de assinatura (a de 6 argumentos foi substituída, a chamada antiga continua válida); o histórico só mostra o nome da fonte depois de uma exclusão.
- Impacto em código, operação e time: migration `20261118010000_add_expert_message_citations.sql` (rollback no comentário); novas variáveis opcionais `EXPERT_RETRIEVAL_MAX_CHUNKS` e `EXPERT_RETRIEVAL_MIN_SCORE`; o `ConnectionsModule` passa a exportar `CONNECTION_REPOSITORY` e o `ConnectionRepository` ganha `hasReadyConnection`; novas séries `expert.retrieval.*` e o log `expert_retrieval`, sem conteúdo; o time de Produto precisa calibrar o limiar e revisar uma amostra de respostas reais antes do release (`QA.md` §1.21). Nenhuma dependência nova.
