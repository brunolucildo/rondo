# 0029 — Gemini para o entendimento de áudio e vídeo

> Decisão da spec `0028`. Numeração definida na integração (0027 é o ADR de imagens da spec `0026`; 0028, o de observabilidade).

- **Status:** aceito
- **Data:** 2026-11-18

## Contexto

A spec `0028` leva `.mp3` e `.mp4` ao índice dos experts. Áudio e vídeo precisam virar **texto com tempo** (fala e, no vídeo, o que aparece) antes de passar pelo chunking, embeddings e índice das specs `0022` e `0023`. É a segunda integração externa do épico (além da OpenAI dos embeddings): arquivos de até 200 MB, processamento de minutos, custo por minuto, dado sensível (voz e imagem de atletas e reuniões de comissão técnica) saindo da máquina e uma chave nova. O pedido original citava "Gemini + gemini-omni-flash"; conferido na documentação, esse modelo **gera e edita** vídeo, e o que lê vídeo e áudio é um modelo Gemini de entendimento multimodal.

## Decisão

Áudio e vídeo são lidos por um **modelo Gemini de entendimento multimodal da família Flash** (`GEMINI_UNDERSTANDING_MODEL`, padrão `gemini-3.6-flash`, lido da documentação em 2026-11-17), pela **Files API**: o servidor envia os bytes da memória, espera o arquivo ficar `ACTIVE`, pede a transcrição com marcas `[MM:SS]` (e `SCENE:` no vídeo) com uma instrução fixa que **proíbe identificar pessoas pelo rosto ou pela voz** e trata a mídia como dado, e **apaga o arquivo no provedor ao fim de qualquer desfecho**. O cliente fica atrás da porta `MediaUnderstanding` (domínio) com adaptador (`GeminiMediaUnderstanding`, SDK `@google/genai` 3.4.0 só em `gemini-client.ts`) e implementação falsa para os testes (`NODE_ENV=test`); a mídia entra no pipeline pela porta `DocumentExtractor` existente. Detalhes e limites em `ARCHITECTURE.md` §4.14.

Decisões que acompanham:

- **Limites** (custo e memória): MP3 50 MB e 60 min, MP4 200 MB e 20 min, duração lida dos metadados sem decodificar (ID3/Xing/VBRI e `mvhd`), 2 mídias em processamento por usuário, 100 minutos por 24 h móveis cobrados no aceite num livro-razão que sobrevive à exclusão da conexão (migration `20261118130000`).
- **Assíncrono e isolado:** o `POST` valida e delega (`202`); uma pista de mídia própria no `ConnectionProcessor` (concorrência 3, fila 3, teto de 22 min), tentativa de 10 min com até 2 tentativas, `processing` de mídia obsoleto após 30 min.
- **Limpeza no provedor:** exclusão em `finally`; se falhar, o identificador fica numa lista em memória e é repetido pela próxima varredura (antes de cada chamada e por timer), com evento de log sem conteúdo; o provedor também expira os arquivos.
- **Citação com tempo:** o chunk guarda só `startSeconds` (início); a citação (`startSeconds` opcional, só para mídia) mostra `nome · mm:ss`. O índice ganha a propriedade opcional `startSeconds`, acrescentada à coleção existente na primeira chamada (retrocompatível).
- **Sem chave:** `503 MEDIA_UNAVAILABLE` só no envio de mídia; o resto do produto não depende do Gemini.

## Alternativas consideradas

| Alternativa | Prós | Contras | Por que não |
| ----------- | ---- | ------- | ----------- |
| `gemini-omni-flash` (o modelo do pedido) | Citado no pedido | É de geração e edição de vídeo (saídas curtas), não de entendimento | Não lê o arquivo; usaria o modelo errado |
| Transcrição local (Whisper em contêiner) mais legenda de quadros | Voz e imagem não saem da máquina | Infra de GPU/CPU pesada, qualidade de vídeo ruim sem modelo de visão, dois sistemas a operar | Custo de operação e escopo muito acima da fase; fica como alternativa se o Jurídico vetar enviar voz e imagem ao Gemini |
| OpenAI (Whisper/`gpt-4o-transcribe`) só para áudio | Um provedor só (já usado nos embeddings) | Não entende vídeo (cenas, texto na tela, placar) | A necessidade de negócio inclui o que aparece no vídeo |
| Extrair quadros e áudio com `ffmpeg` e mandar em partes | Controle fino do custo | Dependência nativa, quadros viram dado biométrico guardado em disco, mais código | Fora do escopo (a spec proíbe quadros e métricas táticas) |
| Enviar o arquivo inline (base64) em vez da Files API | Sem arquivo para apagar | Limite de ~20 MB por requisição, inviável para vídeo | MP4 de até 200 MB |
| Guardar o original e reprocessar depois | Permite legendas e reproduzir o trecho citado | Mais um lugar com voz e imagem, retenção e exclusão próprias (LGPD) | Decisão de não guardar o original (0023); fica no backlog |
| SDK `@google/genai` x HTTP direto (`fetch`) | `fetch` evita dependência | O upload retomável da Files API e os erros tipados dariam código próprio a manter | O SDK oficial isola isso num arquivo (`gemini-client.ts`); versão exata |

## Consequências

- Positivas: MP3 e MP4 viram texto citável com instante; a mesma dedup, exclusão e isolamento dos documentos; o Gemini sai do caminho crítico do chat; falha tipada e sem partes parciais; nada do arquivo em disco; arquivo apagado do provedor em todo desfecho; custo limitado por tamanho, duração, simultaneidade e minutos por dia.
- Negativas: voz e imagem de pessoas saem para um segundo terceiro (aviso à parte e decisão do Jurídico em aberto); o ID do modelo, o preço e a qualidade real **não foram validados com chave real** (só o Gemini falso nos testes) e mudam com frequência; a mídia fica inteira na memória da API (pista de mídia curta para limitar), e a fila é de instância única; a janela de 100 minutos é uma premissa de Produto; uma exclusão no provedor que falha depende da varredura em memória (e da expiração do provedor).
- Impacto em código, operação e time: módulo `connections` (porta, adaptador, fake, extrator, chunker com tempo, pista de mídia, limites), `knowledge` (propriedade `startSeconds`), `experts` (citação com `startSeconds`), `apps/app` (seletor, fila de 2, aviso, `mm:ss`), migration `20261118130000_add_connection_media.sql`, dependência `@google/genai` 3.4.0, variáveis `GEMINI_API_KEY` e `GEMINI_UNDERSTANDING_MODEL` (só servidor), métricas `connection.media.*`. A operação precisa de uma chave de desenvolvimento e de uma amostra real revisada pelo Produto (`QA.md`).
