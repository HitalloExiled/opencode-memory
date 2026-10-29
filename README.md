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
> caminho de instalação. O repo `opencode-tools` consome este projeto como
> **git submodule** em `plugins/memory` e faz o mesmo symlink via `setup.sh`.

## O que o plugin faz

1. **Captura resumos de compactação.** Toda vez que uma sessão é compactada, o
   corpo completo do resumo (Objective, Requirements, Decisions, Work State,
   Next Move, Relevant Files, Important Context) é salvo como um arquivo
   Markdown, um por compactação. Nenhuma transcript é guardada — só o resumo
   que o próprio OpenCode já produziu.
2. **Injeta contexto no início da sessão.** No primeiro turno de uma sessão
   (e de novo se o projeto mudar), o plugin injeta um bloco
   `<memory-context>` com: repositório, branch e último commit (o status do
   working tree fica **fora** do bloco, para não invalidar o cache de prefixo
   do servidor a cada edição — peça o estado atual sob demanda pela ferramenta
   `memory.summaries` com `action=repo`), a **memória persistente** (fatos
   duráveis do mundo/usuário guardados em `profile.json` — quem é o usuário,
   preferências, trabalho em curso, fatos da máquina; fatos `machine` + fatos
   do projeto da sessão, mais recentes primeiro, com quota de
   `MEMORY_PROFILE_MAX` chars e teto de `MEMORY_PROFILE_INJECT` fatos; loja
   vazia → sem seção) e o handoff da sessão anterior do mesmo projeto —
   apenas as seções Objective/Next Move, marcadas como *dados não confiáveis*
   (o corpo completo do resumo nunca entra no system prompt; use
   `memory.summaries` para ler). A memória persistente é **raw e
   determinística**: o texto injetado é 1:1 com a loja (ids incluídos), sem
   nenhum passo de modelo no caminho de injeção — os fatos são mastigados no
   write (a tool e os comandos `/remember`/`/forget` os mantêm curtos e sem
   duplicatas). Junto ao bloco, o plugin injeta também uma pequena regra de
   *memory routing* — orientativa e **aditiva** (nunca substitui as
   instruções originais): consulte a memória antes de agir no mundo quando a
   pergunta já pode estar respondida nela, e persista fatos duráveis novos
   via `memory.profile` (conhecimento curado vai para as notes). Isso nunca
   é persistido — é recalculado a cada injeção.
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
   `action=index-all` (ou `/index-all`).

   Resumos acompanham a sessão: quando uma sessão muda de projeto, os resumos
   dela são movidos do bucket antigo para o novo (consolidação lazy, no
   próximo contato da sessão — injeção ou backfill) — o handoff e a busca do
   novo projeto passam a ver o histórico completo, e os vetores são
   re-bucketeados junto (sem re-embed).

## Onde os dados ficam

```
$XDG_DATA_HOME/opencode/memory/
├── compactions/<projectID>/<timestampUTC>-<messageID>.md   # resumos, um por compactação
├── index.db          # índice FTS5 derivado + tabela `embeddings` (ou index.json sem SQLite)
├── profile.json      # memória persistente: fatos duráveis do mundo/usuário (id-based, scope machine|project:<name>)
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
  vetores antigos: rode `action=embed` de novo e os obsoletos são podados.
- **Degradação graciosa.** Se o engine não iniciar (addon nativo ausente,
  pesos incompletos, `MEMORY_EMBED_DISABLED=1`), a busca volta a ser só por
  palavras-chave e o resultado informa isso.

## Tools (read-only, exceto `memory.profile`; escopo de projeto por padrão)

| Tool | Para quê |
|---|---|
| `memory.summaries` | listar/buscar/ler resumos de compactação (`detail=brief\|full\|sections`) + estado do repo (`action=repo`) |
| `memory.search` | busca híbrida (FTS5 + semântica local, fundida por RRF; cada hit tagueado `via: fts\|vec\|fts+vec` **e com atribuição** `by: <agente> (<modelo>)` / `by: user`) no índice derivado (resumos + texto de usuário/assistente); `scope=project\|all`; `action=index-all` indexa todos os projetos manualmente (`rebuild=true` para rebuild completo); `action=embed` (re)constrói os vetores do escopo |
| `memory.history` | inspecionar a timeline completa de uma sessão (listar sessões, ler página, buscar, buscar uma mensagem; mensagens de assistente mostram `agent:` e `model:`); tool calls e reasoning só entram com `includeTools`/`includeReasoning` explícitos; sessões de outro projeto exigem `scope=all` |
| `memory.profile` | **memória persistente** (a única com escrita): `get` lista os fatos (machine + projeto atual; `all=true` para tudo), `set {value, scope?, id?}` persiste um fato verbatim (≤500 chars; com `id`, atualiza o fato in-place) e `remove {id}` apaga. Scope: `machine` (padrão), `project` (projeto atual) ou `project:<name>`. Fatos têm ids estáveis e são injetados no início de toda sessão |

## Comandos

`/summaries`, `/summary [id] [brief|full|sections]`, `/sessions`, `/index`
(força reindex do projeto), `/index-all` (indexa todos os projetos;
`/index-all rebuild` para rebuild completo), `/repo` (mostra só o estado do
git) e `/recall <algo>` (busca forçada nas superfícies de memória: notas via
CLI `notes`, se existir na máquina, + índice de conversas; cada hit com sua
fonte — nota #N ou sessão + timestamp). Cada um é um atalho que chama as
tools acima.

**Memória persistente** (escrita explícita do usuário, sem depender do
agente lembrar de persistir):

- `/remember <fato>` — persiste o fato **verbatim** na memória persistente,
  com confirmação em 1 linha (id + scope). Prefixo opcional de scope:
  `machine:` (explícito), `project:` (o projeto da sessão) ou
  `project:<nome> <fato>`; sem prefixo, o scope é `machine`. Se já existir
  fato substancialmente igual, ele é atualizado in-place (não duplica).
- `/forget <texto ou id>` — remove o fato que corresponde ao texto
  (case-insensitive) ou ao id: 1 match → remove e confirma; vários → lista
  com ids e pede escolha; zero → lista os fatos atuais com ids.

## Variáveis de ambiente

| Variável | Efeito | Default |
|---|---|---|
| `MEMORY_DATA_DIR` | raiz de dados do plugin (sobrepõe XDG) | `$XDG_DATA_HOME/opencode/memory` |
| `MEMORY_SUMMARY_KEEP` | quantos resumos manter por projeto (os mais antigos são podados, do disco e do índice, quando um novo resumo é capturado — nunca na path de leitura) | `20` |
| `MEMORY_INJECT_MAX` | teto de bytes do bloco `<memory-context>` injetado | `~6 KB` |
| `MEMORY_PROFILE_INJECT` | quantos fatos da memória persistente injetar no `<memory-context>` (`0` desliga a seção) | `12` |
| `MEMORY_PROFILE_MAX` | quota de chars da seção de memória persistente (um fato que não cabe inteiro é omitido, nunca meio-renderizado) | `3000` |
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
       "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/memory"/index.db* \
       "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/memory/profile.json"
```

Para desativar sem remover nada, apague o link
`~/.config/opencode/plugins/memory` e reinicie o OpenCode.

## Desenvolvimento

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # bun test test/
```

Os testes rodam com a engine de embedding desligada (nenhum download de pesos
no processo de teste); a lógica de embed é coberta com uma engine falsa em
`test/embed.test.ts`.
