# opencode-memory

Plugin de memória local para o [OpenCode](https://opencode.ai) (V2). Captura
resumos de compactação, injeta contexto no início de cada sessão e oferece
busca híbrida (FTS5 + embeddings locais em CPU, fundidos por RRF) sobre
sessões e resumos passados. CPU-only: sem daemon, sem serviço remoto, sem rede
por consulta.

O plugin é autocontido: nenhum import de fora do diretório, e nenhum dado é
escrito dentro do repo.

## Instalação

```bash
git clone git@github.com:HitalloExiled/opencode-memory.git
cd opencode-memory
npm install                       # devDeps (onnxruntime-node incluído)
mkdir -p ~/.config/opencode/plugins
ln -sfn "$PWD" ~/.config/opencode/plugins/memory
```

Reinicie o OpenCode (ou aguarde o hot-reload). Os modelos de embedding são
baixados automaticamente na primeira consulta que usa a camada semântica
(com checagem de tamanho), em `embed-models/<model>/` dentro da data dir.

O plugin é carregado como pacote local em `~/.config/opencode/plugins/memory`.

> Pré-publicação: enquanto o plugin não está publicado, o fluxo acima é o
> caminho de instalação. O repo `agent-toolbelt` consome este projeto como
> **git submodule** em `plugins/memory` e faz o mesmo symlink via `setup.sh`.

## O que o plugin faz

1. **Captura resumos de compactação.** Toda vez que uma sessão é compactada, o
   corpo completo do resumo (Objective, Requirements, Decisions, Work State,
   Next Move, Relevant Files, Important Context) é salvo como um arquivo
   Markdown, um por compactação. Nenhuma transcript é guardada — só o resumo
   que o próprio OpenCode já produziu.
2. **Injeta a regra de roteamento.** A cada request do agent loop, o plugin
   anexa um system part próprio com a *memory routing rule* — orientativa e
   **aditiva** (nunca substitui as instruções originais): consulte a memória
   antes de redescobrir algo que uma sessão anterior já achou. O texto é
   constante, então o início do prompt fica byte-idêntico e o cache de prefixo
   do servidor sobrevive. Nenhum bloco de contexto é injetado: estado do
   repositório não é memória, e o resumo da própria sessão já está no contexto
   ativo — o de outra sessão fica a um `memory.summaries` de distância. Nada é
   persistido.
   **Notas são outra camada:** o plugin `notes` injeta o próprio bloco
   `<notes-context>` e a própria regra; este plugin nunca lê `notes.db`.
3. **Permite busca cross-sessão.** Um índice derivado (SQLite FTS5, com
   fallback `LIKE` e, por último, JSON) guarda apenas texto de usuário, texto
   de assistente e resumos — nunca reasoning, nunca chamadas de tool. A busca
   é **híbrida**: além das palavras-chave (FTS5), uma camada semântica local
   (modelos de embedding rodando em CPU, sem daemon nem serviço remoto)
   encontra documentos por intenção, mesmo sem sobreposição de termos — e os
   dois rankings são fundidos por RRF. O backfill é preguiçoso e incremental:
   só acontece quando alguém busca, e só processa sessões/mensagens novas
   desde a última vez. `scope=all` busca o que já está indexado + todos os
   resumos em disco; para indexar todos os projetos manualmente, use
   `memory.index action="index-all"` (ou `/index-all`).
4. **Oferece um painel lateral (GUI).** A aba **Memória** busca conversas
   passadas, agrupa os resultados por sessão e abre a conversa completa com
   scroll infinito. Um toggle restringe a busca ao projeto da sessão atual;
   desligado, busca em todos os projetos. Cada mensagem tem **Adicionar ao
   contexto**, que anexa ao próximo prompt um trecho truncado (padrão 2000
   caracteres) com o tamanho total e o offset do trecho, para o agente ler o
   entorno via `memory.history action="message"` com `charOffset`/`charLimit`.

   Resumos acompanham a sessão: quando uma sessão muda de projeto, os resumos
   dela são movidos do bucket antigo para o novo (consolidação lazy, no
   próximo contato da sessão — injeção ou backfill) — o histórico e a busca do
   novo projeto passam a ver o histórico completo, e os vetores são
   re-bucketeados junto (sem re-embed).

## Onde os dados ficam

```
$XDG_DATA_HOME/opencode/memory/
├── compactions/<projectID>/<timestampUTC>-<messageID>.md   # resumos, um por compactação
├── index.db          # índice FTS5 derivado + tabela `embeddings` (ou index.json sem SQLite)
└── embed-models/<model>/   # pesos dos modelos de embedding locais (baixados uma vez, com checagem de tamanho)
```

O diretório vive dentro da data dir do próprio OpenCode
(`~/.local/share/opencode/`) para ficar no mesmo volume gravável.
`projectID` é o identificador de projeto do próprio OpenCode
(`session.projectID`); sessões sem projeto caem em `global`. Nada é versionado
no repo nem escrito dentro dele.

## Busca semântica local (híbrida com o FTS5)

A consulta de `memory.search` roda dois rankings em paralelo e funde-os por
Reciprocal Rank Fusion (RRF, k=60). Cada resultado carrega a tag `via:`
indicando a camada que o achou: `fts` (só palavras-chave), `vec`
(só semântica) ou `fts+vec` (as duas).

- **Tudo local.** Os embeddings rodam na CPU desta máquina via
  `onnxruntime-node` (modelos ONNX quantizados) — sem daemon, sem API, sem
  rede por consulta. Os pesos são baixados uma única vez, com checagem de
  tamanho, em `embed-models/<model>/`.
- **Modelo padrão: `minilm-qint8`** (384 dim, multilíngue, int8, 235 MB).
  `e5-large-qint8` (1024 dim, 562 MB) fica disponível via
  `MEMORY_EMBED_MODEL=e5-large-qint8`: funciona, mas o export ONNX dele tem o
  espaço de scores comprimido (margem menor entre relevantes e irrelevantes)
  e é ~3× mais lento.
- **Multi-vetor por documento.** O texto é cortado em 4096 caracteres e
  dividido em chunks que cabem na janela do modelo; a pontuação do documento
  é o máximo cosseno entre seus chunks.
- **Lazy e incremental.** Os vetores são gerados em segundo plano após cada
  upsert (nunca bloqueiam a busca por palavras). Documentos inalterados (mesmo
  hash de conteúdo + mesmo modelo) são pulados. Trocar de modelo invalida os
  vetores antigos: rode `memory.index action="embed"` de novo e os obsoletos são
  podados.
- **Degradação graciosa.** Se o engine não iniciar (addon nativo ausente,
  pesos incompletos, `MEMORY_EMBED_DISABLED=1`), a busca volta a ser só por
  palavras-chave e o resultado informa isso.

## Tools (escopo de projeto por padrão)

As três primeiras são **read-only**; `memory.index` só mexe no índice derivado.

| Tool | Para quê |
|---|---|
| `memory.search` | busca híbrida cross-sessão (FTS5 + semântica local, fundida por RRF; cada hit tagueado `via: fts\|vec\|fts+vec` **e com atribuição** `by: <agente> (<modelo>)` / `by: user`) no índice derivado (resumos + texto de usuário/assistente); `scope=project\|all`; `offset` pagina os hits; `since`/`until` recortam por data |
| `memory.summaries` | listar/buscar/ler resumos de compactação (`detail=brief\|full\|sections`), com `since`/`until` em `list` e `search` |
| `memory.history` | timeline de uma sessão: `sessions`, `read` (cursor), `search` (`role`, `window`, `offset`), `message` (a mensagem inteira ou uma janela `charOffset`/`charLimit`); mensagens de assistente mostram `agent:` e `model:`; tool calls e reasoning só entram com `include=[...]` |
| `memory.index` | manutenção do índice: `stats`, `reindex`, `index-all` (`rebuild`), `embed` (`scope`) e `doctor` (`scope`) — o checkup lista cada achado com a ação que conserta e o que ele **não** checa |

## GUI (painel Memória)

A aba lateral **Memória** (`./gui-experimental`) fala com o plugin servidor por
RPC — ela não abre o `index.db` nem o banco do OpenCode. O fluxo:

- **Busca** híbrida no índice, com debounce.
- **Só este projeto** (toggle): ligado usa o projeto da sessão roteada;
  desligado usa `scope=all`.
- **Resultados por sessão**: cada card mostra título, projeto, data e até 3
  trechos com os termos destacados. Clicar abre a **conversa completa**, que
  carrega páginas de mensagens conforme o scroll chega ao fim.
- **Conversa**: renderizada como Markdown e limitada a mensagens `user` e
  `assistant` (resumos, synthetic e system ficam fora da tela). O botão
  **Paginar** alterna entre scroll infinito e navegação por página
  (Anterior/Próxima), usando o cursor da timeline.
- **Seleção**: o texto é selecionável; ao selecionar um trecho dentro de uma
  mensagem, o botão vira **Quotar seleção** e envia apenas o trecho escolhido.
- **Adicionar ao contexto**: anexa um quote ao composer da sessão atual. O
  trecho é truncado em N caracteres (seletor 1000/2000/4000) e o cabeçalho
  informa `chars start–end de total`, `offset` e a chamada exata para o agente
  continuar a leitura:

  ```
  memory.history action="message" sessionID="..." messageID="..." charOffset=... charLimit=...
  ```

  `action="message"` devolve a janela pedida, o total e os offsets
  `previous`/`next`, então o agente consegue navegar em torno da ocorrência sem
  despejar a mensagem inteira no contexto.

Build da GUI:

```bash
npm run typecheck:gui
npm run gui:build      # dist/gui-experimental.cjs
```

## Comandos

`/summaries`, `/summary [id] [brief|full|sections]`, `/sessions`, `/index`
(mostra o stats do índice; `/index rebuild` força o reindex do projeto),
`/index-all` (indexa todos os projetos; `/index-all rebuild` para rebuild
completo) e `/recall <algo>` (busca forçada no índice de conversas; cada hit com
sua fonte — sessão + timestamp). Cada um é um atalho que chama as tools acima.
Comandos de notas (`/pin`, `/unpin`) pertencem ao plugin `notes`.

## Variáveis de ambiente

| Variável | Efeito | Default |
|---|---|---|
| `MEMORY_DATA_DIR` | raiz de dados do plugin (sobrepõe XDG) | `$XDG_DATA_HOME/opencode/memory` |
| `MEMORY_SUMMARY_KEEP` | quantos resumos manter por projeto (os mais antigos são podados, do disco e do índice, quando um novo resumo é capturado — nunca na path de leitura) | `20` |
| `MEMORY_INDEX_TEXT_MAX` | teto de caracteres de texto indexado por documento | — |
| `MEMORY_BACKFILL_SESSIONS` | teto de sessões processadas por backfill | — |
| `MEMORY_BACKFILL_MESSAGES` | teto de mensagens processadas por sessão no backfill | — |
| `MEMORY_EMBED_MODEL` | modelo de embedding local da camada semântica (`minilm-qint8` ou `e5-large-qint8`); trocar o modelo invalida os vetores antigos | `minilm-qint8` |
| `MEMORY_EMBED_DISABLED` | `1` desliga a camada semântica (busca só por palavras-chave) | — |

## Privacidade e remoção

Tudo fica fora do repo, em `$XDG_DATA_HOME/opencode/memory/`
(permissões `0700`/`0600`). Para apagar os dados do plugin de fato:

```bash
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/memory/compactions" \
       "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/memory"/index.db*
```

Para desativar sem remover nada, apague o link
`~/.config/opencode/plugins/memory` e reinicie o OpenCode.

## Desenvolvimento

```bash
npm install --legacy-peer-deps
npm run typecheck       # tsc --noEmit (tools + RPC)
npm run typecheck:gui   # tsc -p tsconfig.gui.json (Solid JSX)
npm run gui:build       # vite build -> dist/gui-experimental.cjs
npm test                # bun test test/
```

Os testes rodam com a engine de embedding desligada (nenhum download de pesos
no processo de teste); a lógica de embed é coberta com uma engine falsa em
`test/embed.test.ts`.
