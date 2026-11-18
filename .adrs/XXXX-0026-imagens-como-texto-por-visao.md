# XXXX — Imagens como conexão: visão converte em texto, o resto do pipeline não muda

- **Status:** aceito
- **Data:** 2026-11-17
- **Spec:** `0026-connections-images`

## Contexto

Depois das specs `0023` a `0025` só PDF, TXT e Markdown viram conhecimento do usuário. Boa parte do material de um clube é imagem (súmula fotografada, tabela em print, gráfico de carga, escalação no quadro). A spec `0026` aceita JPG, JPEG e PNG no mesmo `POST /api/v1/connections`, com a mesma deduplicação, listagem, exclusão e citação. A decisão é como uma imagem, que não tem texto, entra num pipeline que só entende texto, sem abrir uma segunda via de ingestão, sem guardar o original e sem identificar pessoas.

## Decisão

1. **Visão converte, o pipeline é o mesmo:** `ImageDocumentExtractor` é mais uma implementação da porta `DocumentExtractor` da `0023`. Pede ao modelo de visão (`gpt-4o-mini`) uma descrição objetiva e a transcrição do texto visível; a resposta vira uma seção sem página e segue para o chunking, os embeddings e o índice. Citação por nome e `page: null`; listagem e exclusão da `0025` valem sem mudança.
2. **Porta de visão e adaptadores:** a porta `ImageDescriber` (domínio) tem o adaptador `LangChainImageDescriber` sobre um `BaseChatModel` (`ChatOpenAI` de `@langchain/openai`, já instalado: **sem dependência nova**), o `ScriptedImageDescriber` (testes, escolhido por `NODE_ENV=test`, nunca toca a rede) e o `UnavailableImageDescriber` (sem `OPENAI_API_KEY`). A escolha é função do ambiente em `parseVisionConfig` (como o modelo de chat e o e-mail `capture`); `OPENAI_VISION_MODEL` é opcional (padrão `gpt-4o-mini`). Toda chamada passa por `InstrumentedImageDescriber` (duração por `outcome`, sem conteúdo).
3. **Instrução fixa e texto como dado:** a instrução (`VISION_INSTRUCTION`) nunca é montada com entrada do usuário; manda descrever só o visível, transcrever fielmente, **proíbe identificar, nomear ou descrever pessoas pelo rosto ou traço biométrico**, trata o texto da imagem como dado a transcrever (nunca ordem) e pede o marcador `NO_RELEVANT_CONTENT` quando não há nada. A transcrição chega ao expert no bloco delimitado e escapado da `0024`, como qualquer trecho.
4. **Validação pelos bytes, sem biblioteca:** assinatura (JPEG `FF D8 FF`, PNG `89 50 4E 47`) e tamanho em pixels lidos do cabeçalho (IHDR do PNG, marcador SOF do JPEG); até 10 MB e 8.000 px por lado; cabeçalho ilegível é `UNSUPPORTED_FILE`. O MIME enviado à visão vem da assinatura, não da extensão. Erros novos: `400 IMAGE_TOO_LARGE`, `413 FILE_TOO_LARGE` com o limite de 10 MB para imagem.
5. **Falhas tipadas:** vazio ou marcador sem conteúdo é `NO_EXTRACTABLE_TEXT`; recusa do provedor (campo `refusal`, `content_filter`, 400 ou 422) é o novo `CONTENT_NOT_PROCESSABLE`, sem nova tentativa; timeout (30 s por tentativa), 429, 5xx ou rede são `PROCESSING_UNAVAILABLE` depois de 2 tentativas. O timeout do processador para imagem sobe para 70 s (2 tentativas mais a espera). A compensação da `0023` (remover vetores parciais) vale.
6. **Saída limitada:** 4.000 caracteres, cortados sem partir um par substituto; `maxTokens` de 2.000 no modelo.
7. **Dados e privacidade:** a migration só amplia o `check` de `connections.kind` com `image`; o original nunca é guardado (nem miniatura) e a imagem não vai a disco (o envio à visão é em memória, por data URL); nome, hash, texto transcrito e bytes nunca vão a log, span ou métrica (`kind=image` no contador existente e o histograma `connection.vision.duration` com `outcome` fechado). O aviso de privacidade passa a dizer que imagens também vão ao provedor de IA.

## Alternativas consideradas

| Alternativa | Prós | Contras | Por que não |
| --- | --- | --- | --- |
| OCR dedicado (Tesseract, serviço de OCR) | Transcrição determinística e barata | Dependência nativa ou serviço novo; não descreve gráficos nem quadros táticos; pior em foto torta | A spec fixa o `gpt-4o-mini` sem OCR; pergunta de OCR dedicado fica com o Produto |
| Biblioteca de imagem (`sharp`, `image-size`) para dimensões e redimensionamento | Leitura robusta e redução de custo de tokens | Binário nativo ou dependência nova para ler 24 bytes de cabeçalho | Leitura do cabeçalho em ~60 linhas cobre a regra; o redimensionamento fica para quando a telemetria mostrar custo alto |
| Enviar a imagem direto à pergunta (visão na conversa) | Sem indexação | Fora do escopo; reprocessa a imagem a cada pergunta e não deixa fonte citável | Backlog da spec |
| Fila e extrator separados para imagem | Isola o custo da visão | Segundo pipeline para manter; dedup, exclusão e citação duplicados | Uma porta de extrator por tipo basta |
| Validar só extensão e `Content-Type` | Simples | Qualquer arquivo renomeado chega ao provedor de IA | Os bytes decidem, como no PDF |

## Consequências

- Positivas: imagem entra no mesmo caminho de dedup, listagem, exclusão e citação sem código novo nessas partes; nenhuma dependência nova; testes sem rede (visão e embeddings falsos); falhas com códigos fechados e mensagens claras.
- Negativas: a qualidade depende do modelo de visão (pode "inventar" detalhes; mitigado pela instrução e pela citação por nome, revisão em `QA.md`); sem redimensionamento, imagens grandes custam mais tokens (limites de 10 MB e 8.000 px e `detail: "auto"`); a avaliação com o modelo real depende de `OPENAI_API_KEY` e fica pendente; uma imagem com dado de saúde ou rosto vai a um terceiro (aviso, exclusão completa e original não guardado são a mitigação; o texto do aviso é do Jurídico).
- Impacto em código, operação e time: `modules/connections` ganha a porta `ImageDescriber`, o extrator de imagem, três adaptadores e a validação de imagem; migration `20261118020000_add_connection_image_kind.sql` (rollback no comentário, exige apagar antes as linhas `image`); `OPENAI_VISION_MODEL` opcional; o teste de fronteira de `connections` garante que o fake só é escolhido por `NODE_ENV=test`.
