/** Slash commands. Each one expands into a prompt that drives the plugin tools. */

import type { PluginContext } from "./context.js";

interface Definition {
  name: string;
  description: string;
  /** Receives the raw arguments typed after the command. */
  prompt: (args: string) => string;
}

const COMMANDS: Definition[] = [
  {
    name: "summaries",
    description: "List the compaction summaries stored for this project",
    prompt: (args) =>
      [
        'Call memory.summaries with action="list" for the current project.',
        "Show date, session, title and objective of each summary, newest first.",
        "Do not invent entries; report exactly what the tool returns.",
        args ? `User arguments: ${args}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
  },
  {
    name: "summary",
    description: "Read one compaction summary (default: the most recent)",
    prompt: (args) => {
      const [id = "latest", detail] = args.split(/\s+/).filter(Boolean);
      return [
        `Call memory.summaries with action="read", id="${id}"${
          detail ? `, detail="${detail}"` : ', detail="brief"'
        }.`,
        "Summarize the result for me and mention that full/sections detail is available.",
      ].join("\n");
    },
  },
  {
    name: "sessions",
    description: "List recent sessions of this project",
    prompt: (args) =>
      [
        'Call memory.history with action="sessions" for the current project.',
        args ? `Use query="${args.replace(/"/g, '\\"')}" to filter by title or project path.` : "",
        "Present id, date and title so I can pick one.",
      ]
        .filter(Boolean)
        .join("\n"),
  },
  {
    name: "index",
    description: "Show (or rebuild) the cross-session search index of this project",
    prompt: (args) => {
      const wantsRebuild = /\b(rebuild|reindex|--rebuild)\b/i.test(args);
      return wantsRebuild
        ? 'Call memory.search with action="reindex" and report the result.'
        : 'Call memory.search with action="stats" and report the result. Mention that "/index rebuild" forces a reindex and "/index-all" indexes every project.';
    },
  },
  {
    name: "index-all",
    description: "Manually index every project (summaries + session timelines)",
    prompt: (args) => {
      const wantsRebuild = /\b(rebuild|full|--rebuild)\b/i.test(args);
      return [
        `Call memory.search with action="index-all"${wantsRebuild ? " and rebuild=true" : ""} and report the per-project result.`,
        "Mention that '/index-all rebuild' forces a full rebuild instead of the incremental default.",
      ].join("\n");
    },
  },
  {
    name: "repo",
    description: "Show the current repository state",
    prompt: () => 'Call memory.summaries with action="repo" and report the result verbatim.',
  },
  {
    name: "recall",
    description: 'Force a memory search for something ("what did we decide X", "when did X happen", "where is Y")',
    prompt: (args) => {
      const query = args.trim();
      if (!query) return "Usage: /recall <something to recall> — e.g. /recall where is the opencode source clone";
      const q = query.replace(/"/g, '\\"');
      return [
        `Force a memory search for "${q}" — do not answer from context alone; query the memory surfaces:`,
        `1. Long-term notes (curated knowledge: decisions, solved problems, config): run \`notes search "${q}"\` via the notes CLI, if that CLI is available on this machine.`,
        `2. Conversation index (what was said/done in past sessions): call memory.search with query="${q}", scope="project"; if nothing is found, retry with scope="all".`,
        '3. If the query is about a specific session or "when did X happen": use memory.history (action="sessions", then action="search" with a cursor into the session).',
        "Report every hit with its source (note #N / session id + timestamp). If no surface has it, say so explicitly — it may predate the index (mention /index-all), or it may be a durable fact worth registering as a note.",
      ].join("\n");
    },
  },
];

export async function registerCommands(ctx: PluginContext) {
  return ctx.command.transform((editor) => {
    for (const command of COMMANDS) {
      editor.add({
        name: command.name,
        description: command.description,
        async execute({ sessionID, prompt, delivery }) {
          const args = (prompt.text ?? "").trim();
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: command.prompt(args),
            delivery,
          } as never);
        },
      });
    }
  });
}
