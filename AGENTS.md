# AGENTS.md — working on `opencode-memory`

Agent-facing operating notes: how to build, typecheck and test the plugin.
Read `README.md` for product docs (PT-BR).

## What this is

`opencode-memory` is a self-contained OpenCode (V2) plugin:

- **Capture** — saves every compaction summary as Markdown under the data dir.
- **Injection** — adds a `<memory-context>` block plus the memory-routing rule
  to the first request of a session (never persisted).
- **Search** — hybrid FTS5 + local CPU embeddings over user/assistant text and
  summaries (`memory.search`, `memory.summaries`).
- **GUI** — a SolidJS side panel (`./gui-experimental`).

Data lives under `~/.local/share/opencode/`; nothing is written inside the
repo. There is no external CLI and no daemon.

## Repo layout

```
index.ts                 plugin entry (tools, injection, service)
tools.ts                 memory.* tool definitions
src/                     GUI source (SolidJS + RPC)
test/                    bun tests
dist/gui-experimental.cjs  BUILT GUI artifact (gitignored)
```

## Hard rules (do not violate)

- **UI copy is PT-BR; code is English.**
- **Every user-facing message — UI copy, toasts and synthetic/session
  messages — must exist in PT-BR and EN-US, with EN-US as the fallback.** Code
  and identifiers stay English. Never hardcode a UI or synthetic string in a
  single language.
- **Never read OpenCode's `opencode.db` directly.** GUI/app data comes from the
  official `ctx.client.*` APIs only.
- **Do not write data inside the repo.** Models, indexes and summaries go under
  the OpenCode data dir.
- **Notes are another layer.** This plugin never reads `notes.db`; the notes
  plugin injects its own `<notes-context>`.

## Build / typecheck / test

```bash
npm install --legacy-peer-deps
npm run typecheck       # tsc --noEmit (tools + RPC)
npm run typecheck:gui   # tsc -p tsconfig.gui.json (Solid JSX)
npm run gui:build       # vite build -> dist/gui-experimental.cjs
npm test                # bun test test/
```

After editing `src/**` (GUI), run `npm run gui:build`: the app loads
`dist/gui-experimental.cjs`, not the TypeScript source.

## Hot reload

The running OpenCode service watches the plugin; a rebuild triggers a reload.
Confirm in `~/.local/share/opencode/log/opencode.log` (`"loading plugin" …
plugins/memory`, no new `ERROR`/`WARN`).

## Git workflow (two-part)

`plugins/memory` is a **git submodule** (its own repo, `opencode-memory`); the
parent `opencode-tools` tracks the pointer.

1. Commit + push the **submodule first** (`plugins/memory`).
2. Then `git add plugins/memory`, commit + push the **parent** pointer bump.

## Live paths (debugging)

| Thing | Path |
|---|---|
| Data dir | `~/.local/share/opencode/memory/` |
| OpenCode DB (sessions/projects) | `~/.local/share/opencode/opencode.db` — **context only, do NOT read directly** |
| OpenCode log | `~/.local/share/opencode/log/opencode.log` |
| Plugin install (symlink) | `~/.config/opencode/plugins/memory` → this repo |
