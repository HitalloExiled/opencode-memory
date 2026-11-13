/** The tools exposed by the plugin: three read paths plus index maintenance. */

import type { PluginContext } from "./context.js";
import type { Runtime } from "./runtime.js";
import type { MessageKind } from "./types.js";
import { embedDocs, getEngine } from "./embed.js";
import { embedDisabled, embedModelName } from "./paths.js";
import { indexAllProjects, reindexProject } from "./indexer.js";
import { currentProject } from "./src/scope.js";
import { formatSearchHits, searchMemory } from "./src/search.js";
import {
  findSummary,
  formatBrief,
  formatFull,
  formatSections,
  formatSummaryList,
  formatSummarySearch,
  listAllSummaries,
  listSummaries,
  searchSummaries,
} from "./summaries.js";
import {
  formatHistorySearch,
  formatMessage,
  formatSessionList,
  formatTimeline,
  getHistoryApi,
  listSessions,
  messageCreated,
  readMessageContent,
  readPage,
  searchSession,
} from "./history.js";
import type { HistoryPage, HistorySearchHit, HistorySource } from "./history.js";
import { fmtDate, parseDateBound } from "./util.js";

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function bool(input: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = input[key];
  return typeof value === "boolean" ? value : fallback;
}

function strings(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}

function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function inRange(created: number, range: { since?: number; until?: number }): boolean {
  if (range.since !== undefined && created < range.since) return false;
  if (range.until !== undefined && created > range.until) return false;
  return true;
}

/** Shared `since`/`until` parsing for the search tools. */
function dateRange(input: Record<string, unknown>): { since?: number; until?: number; error?: string } {
  const sinceText = str(input, "since");
  const untilText = str(input, "until");
  const since = sinceText ? parseDateBound(sinceText, "start") : undefined;
  const until = untilText ? parseDateBound(untilText, "end") : undefined;
  if (sinceText && since === undefined) return { error: `Invalid since "${sinceText}": use YYYY-MM-DD or an ISO timestamp.` };
  if (untilText && until === undefined) return { error: `Invalid until "${untilText}": use YYYY-MM-DD or an ISO timestamp.` };
  if (since !== undefined && until !== undefined && since > until) {
    return { error: "Empty range: since is after until." };
  }
  return { since, until };
}

export async function registerTools(ctx: PluginContext, runtime: Runtime) {
  return ctx.tool.transform((editor) => {
    // Namespaced tools (memory.search / memory.summaries / memory.history),
    // matching the built-in browser.* pattern: one "memory" group in the
    // catalog, no collision with other tool families (notes_*, sandbox_*).
    // editor.namespace() only labels the group (its description shows in the
    // catalog); the per-tool options.namespace is what actually prefixes the
    // qualified name (tools.memory.*) in Code Mode.
    editor.namespace({
      name: "memory",
      description:
        "Local memory for this machine: hybrid search over past conversations and compaction summaries, summary inspection, full session timelines, and index maintenance.",
    });
    editor.add({
      name: "search",
      description: [
        "Past sessions: what was said, decided or found. Hybrid keyword+semantic, cross-session.",
        "Hits carry session and messageID — quote with memory.history action=\"message\".",
        "Index maintenance: memory.index.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "Intent, not exact words." },
          scope: { type: "string", enum: ["project", "all"], description: "project (default) or all." },
          kind: {
            type: "string",
            enum: ["any", "summary", "user", "assistant"],
            description: "Document kind (any).",
          },
          since: { type: "string", description: "Lower bound: YYYY-MM-DD or ISO." },
          until: { type: "string", description: "Upper bound: YYYY-MM-DD or ISO." },
          limit: { type: "number", description: "1-50 (20)." },
          offset: { type: "number", description: "Skip N hits." },
        },
        additionalProperties: false,
      },
      async execute(raw, context) {
        const input = record(raw);
        const { projectID } = await currentProject(ctx, context.sessionID);
        const query = str(input, "query");
        if (!query) return { content: "Provide `query` to search past sessions." };

        const scope = str(input, "scope") === "all" ? "all" : "project";
        const kind = (str(input, "kind") ?? "any") as MessageKind | "any";
        const limit = num(input, "limit", 20, 1, 50);
        const offset = num(input, "offset", 0, 0, 100_000);
        const range = dateRange(input);
        if (range.error) return { content: range.error };

        const result = await searchMemory(runtime, {
          projectID,
          scope,
          query,
          kind,
          since: range.since,
          until: range.until,
          limit,
          offset,
        });
        const hits = result.hits;
        const partialNote = result.partial
          ? "\n\n> Partial index: some sessions could only be read from the active context."
          : "";
        const vectorNote = result.vectorNote ? `\n\n${result.vectorNote}` : "";

        if (hits.length === 0) {
          return {
            content:
              `No matches for "${query}" (scope: ${scope}, kind: ${kind}).` +
              `\nTry scope="all", a different wording, or memory.index action="reindex".${partialNote}${vectorNote}`,
          };
        }

        const lines = formatSearchHits(hits, context.sessionID);
        const next = result.hasMore
          ? `> More hits: call again with offset=${offset + limit}.`
          : "Read more with memory.summaries (summaries) or memory.history (full messages).";
        return {
          content:
            `${hits.length} match(es) for "${query}" (scope: ${scope}).\n\n${lines.join("\n")}` +
            `\n\n${next}${partialNote}${vectorNote}`,
        };
      },
      // Kept in the Code Mode catalog regardless of the per-namespace budget:
      // this is the entry point for recall, so it must never be a `search()` away.
      options: { namespace: "memory", pinned: true },
    });

    editor.add({
      name: "summaries",
      description: [
        "Read compaction summaries stored for this project.",
        "Use to recover where a past session left off (Objective/Next Move).",
        "Actions: list, search, read (detail brief|full|sections).",
        "Read-only and scoped to the current project unless scope=all.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "search", "read"], description: "list (default), search, read." },
          id: { type: "string", description: "read: summary id or latest." },
          query: { type: "string", description: "search: words." },
          detail: { type: "string", enum: ["brief", "full", "sections"], description: "read: how much (brief)." },
          sections: { type: "array", items: { type: "string" }, description: "sections: headings (Objective)." },
          scope: { type: "string", enum: ["project", "all"], description: "project (default) or all." },
          since: { type: "string", description: "list/search: lower bound (YYYY-MM-DD or ISO)." },
          until: { type: "string", description: "list/search: upper bound (YYYY-MM-DD or ISO)." },
          limit: { type: "number", description: "Items (10)." },
        },
        additionalProperties: false,
      },
      async execute(raw, context) {
        const input = record(raw);
        const action = str(input, "action") ?? "list";
        const scope = str(input, "scope") === "all" ? "all" : "project";
        const limit = num(input, "limit", 10, 1, 50);
        const { projectID } = await currentProject(ctx, context.sessionID);
        const range = dateRange(input);
        if (range.error) return { content: range.error };

        if (action === "search") {
          const query = str(input, "query");
          if (!query) return { content: "Provide `query` for action=search." };
          const results = await searchSummaries(scope === "all" ? undefined : projectID, query, limit, range);
          return { content: formatSummarySearch(results) };
        }

        if (action === "read") {
          const id = str(input, "id") ?? "latest";
          const record_ = await findSummary(scope === "all" ? undefined : projectID, id);
          if (!record_) {
            const available = scope === "all" ? await listAllSummaries(10) : await listSummaries(projectID, 10);
            return {
              content:
                `No summary matching "${id}" ${scope === "all" ? "across projects" : "in this project"}.` +
                (available.length ? `\n\nAvailable:\n${formatSummaryList(available)}` : ""),
            };
          }
          const detail = str(input, "detail") ?? "brief";
          if (detail === "full") return { content: formatFull(record_) };
          if (detail === "sections") return { content: formatSections(record_, strings(input, "sections")) };
          return { content: formatBrief(record_) };
        }

        const records =
          scope === "all" ? await listAllSummaries(limit, range) : await listSummaries(projectID, limit, range);
        const header =
          scope === "all"
            ? `Most recent compaction summaries across all projects (${records.length}):`
            : `Most recent compaction summaries for this project (${records.length}):`;
        return {
          content: `${header}\n\n${formatSummaryList(records)}\n\nRead one with action="read" and its id.`,
        };
      },
      // Kept in the Code Mode catalog: the handoff block points here for the
      // full summary, so it must not be a `search()` away.
      options: { namespace: "memory", pinned: true },
    });

    editor.add({
      name: "history",
      description: [
        "One session's timeline: sessions, read (cursor), search (windows), message (char window).",
        "Read/search/message require sessionID; to scan every session use memory.search.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["sessions", "read", "search", "message"],
            description: "sessions (default), read, search, message.",
          },
          sessionID: { type: "string", description: "Required by read/search/message." },
          query: { type: "string", description: "search: words. sessions: title/path. message: center." },
          messageID: { type: "string", description: "message: the message to open." },
          limit: { type: "number", description: "Items (20; read 40)." },
          offset: { type: "number", description: "Skip N items (search)." },
          cursor: { type: "string", description: "read: next-page cursor." },
          order: { type: "string", enum: ["asc", "desc"], description: "read: asc or desc." },
          include: {
            type: "array",
            items: { type: "string", enum: ["tools", "reasoning"] },
            description: "tools, reasoning (hidden by default).",
          },
          window: { type: "number", description: "search: chars per match (260)." },
          role: { type: "string", enum: ["all", "user", "assistant"], description: "search: author (all)." },
          scope: { type: "string", enum: ["project", "all"], description: "sessions: project (default) or all." },
          since: { type: "string", description: "search/read: lower bound (YYYY-MM-DD or ISO)." },
          until: { type: "string", description: "search/read: upper bound (YYYY-MM-DD or ISO)." },
          charLimit: { type: "number", description: "message: window size (2000)." },
          charOffset: { type: "number", description: "message: start (query if omitted)." },
        },
        additionalProperties: false,
      },
      async execute(raw, context) {
        const input = record(raw);
        const action = str(input, "action") ?? "sessions";
        const include = strings(input, "include").map((entry) => entry.toLocaleLowerCase());
        const includeTools = include.includes("tools");
        const includeReasoning = include.includes("reasoning");
        const { projectID } = await currentProject(ctx, context.sessionID);

        if (action === "sessions") {
          const scope = str(input, "scope") === "all" ? "all" : "project";
          const limit = num(input, "limit", 20, 1, 100);
          const offset = num(input, "offset", 0, 0, 10_000);
          const sessions = await listSessions(ctx, {
            projectID,
            scope,
            limit,
            offset,
            query: str(input, "query"),
          });
          const more = sessions.length >= limit ? `\n\n> More sessions: offset=${offset + limit}.` : "";
          return {
            content: `Sessions (${scope === "all" ? "all projects" : "this project"}):\n\n${formatSessionList(sessions)}${more}`,
          };
        }

        const sessionID = str(input, "sessionID");
        if (!sessionID) {
          return {
            content:
              `Provide \`sessionID\` for action=${action}. ` +
              "To scan across sessions use memory.search with query and since/until.",
          };
        }

        if (action === "read") {
          const limit = num(input, "limit", 40, 1, 100);
          const order = str(input, "order") === "asc" ? "asc" : "desc";
          const range = dateRange(input);
          if (range.error) return { content: range.error };
          let read: { page: HistoryPage; partial: boolean; source: HistorySource };
          try {
            read = await readPage(ctx, sessionID, {
              limit,
              order,
              cursor: str(input, "cursor"),
            });
          } catch (error) {
            const detail = error instanceof Error && error.message ? error.message : "session not found";
            return {
              content: `Could not read session \`${sessionID}\`: ${detail}. Check the id with action="sessions".`,
            };
          }
          const { page, partial, source } = read;
          const all = order === "desc" ? [...page.data].reverse() : page.data;
          const messages = all.filter((message) => inRange(messageCreated(message), range));
          const outside = all.length - messages.length;
          const body = formatTimeline(messages, { includeTools, includeReasoning });
          const next = page.cursor?.next;
          const notes = [
            partial ? `> Partial: only the active context is available here (source: ${source}).` : "",
            outside ? `> ${outside} message(s) on this page are outside the date window.` : "",
            messages.length === 0 && next
              ? "> This page has no messages in the window; the cursor still points past it."
              : "",
            next ? `> More messages available; call again with cursor="${next}".` : "",
            !includeTools ? '> Tool calls hidden; pass include=["tools"] to see them.' : "",
          ].filter(Boolean);
          return {
            content:
              `Session \`${sessionID}\` — ${messages.length} message(s).\n\n${body || "(nothing to show)"}` +
              (notes.length ? `\n\n${notes.join("\n")}` : ""),
          };
        }

        if (action === "search") {
          const query = str(input, "query");
          if (!query) return { content: "Provide `query` for action=search." };
          const range = dateRange(input);
          if (range.error) return { content: range.error };
          const limit = num(input, "limit", 20, 1, 100);
          const offset = num(input, "offset", 0, 0, 100_000);
          let result: { hits: HistorySearchHit[]; hasMore: boolean; partial: boolean; source: HistorySource };
          try {
            result = await searchSession(ctx, sessionID, query, {
              includeTools,
              includeReasoning,
              role: (str(input, "role") ?? "all") as "all" | "user" | "assistant",
              limit,
              offset,
              context: num(input, "window", 260, 80, 4000),
              since: range.since,
              until: range.until,
            });
          } catch (error) {
            const detail = error instanceof Error && error.message ? error.message : "session not found";
            return {
              content: `Could not search session \`${sessionID}\`: ${detail}. Check the id with action="sessions".`,
            };
          }
          const more = result.hasMore ? `\n\n> More matches: call again with offset=${offset + limit}.` : "";
          return {
            content:
              `Matches for "${query}" in \`${sessionID}\`:\n\n${formatHistorySearch(result, sessionID)}` +
              `\n\nFetch one with action="message" and its messageID.${more}`,
          };
        }

        if (action === "message") {
          const messageID = str(input, "messageID");
          if (!messageID) return { content: "Provide `messageID` for action=message." };
          const rawOffset = input["charOffset"];
          const charOffset =
            typeof rawOffset === "number" && Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : undefined;
          const charLimit = input["charLimit"] === undefined ? undefined : num(input, "charLimit", 2000, 1, 8000);
          const query = str(input, "query");
          const wantsWindow = charOffset !== undefined || charLimit !== undefined || query !== undefined;

          if (!wantsWindow) {
            const { api, source } = await getHistoryApi(ctx, sessionID);
            try {
              const message = await api.get({ sessionID, messageID });
              // Same defaults as read/search: tool payloads are opt-in.
              const text = formatMessage(message, { includeTools, includeReasoning });
              if (!text) return { content: `Message ${messageID} has no displayable content.` };
              const note = includeTools ? "" : '\n\n> Tool calls hidden; pass include=["tools"] to see them.';
              return { content: text + note };
            } catch (error) {
              return {
                content: `Could not read ${messageID} from ${sessionID} (source: ${source}): ${
                  error instanceof Error ? error.message : String(error)
                }`,
              };
            }
          }

          const limit = charLimit ?? 2000;
          let content;
          try {
            const fallback = await runtime.index
              .docsByIds([messageID, `summary:${messageID}`])
              .catch(() => []);
            const fallbackText =
              fallback.find((doc) => doc.messageID === messageID)?.text ?? fallback[0]?.text;
            content = await readMessageContent(ctx, sessionID, messageID, {
              query,
              offset: charOffset,
              limit,
              includeTools,
              includeReasoning,
              fallbackText,
            });
          } catch (error) {
            return {
              content: `Could not read ${messageID} from ${sessionID}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            };
          }
          if (!content.text) return { content: `Message ${messageID} has no displayable content.` };
          const previous = content.start > 0 ? Math.max(0, content.start - limit) : undefined;
          const next = content.end < content.total ? content.end : undefined;
          const nav = [
            previous !== undefined ? `previous: charOffset ${previous}` : "",
            next !== undefined ? `next: charOffset ${next}` : "",
          ]
            .filter(Boolean)
            .join(" · ");
          const header = [
            `Session \`${sessionID}\` · message \`${messageID}\` · kind: ${content.kind}` +
              (content.created ? ` · created: ${fmtDate(content.created)}` : "") +
              (content.agent ? ` · agent: ${content.agent}` : "") +
              (content.model ? ` · model: ${content.model}` : ""),
            `Chars ${content.start}–${content.end} of ${content.total} (charOffset ${content.offset}, charLimit ${content.length}).` +
              (nav ? ` [${nav}]` : ""),
          ];
          const note = includeTools ? "" : '\n\n> Tool calls hidden; pass include=["tools"] to see them.';
          return { content: `${header.join("\n")}\n\n${content.text}${note}` };
        }

        return { content: `Unknown action "${action}". Use sessions, read, search or message.` };
      },
      // Kept in the Code Mode catalog: "what happened in session X" is the
      // timeline question, and this is the authoritative source.
      options: { namespace: "memory", pinned: true },
    });

    editor.add({
      name: "index",
      description: [
        "Maintain the local memory index; reading never needs this.",
        "Actions: stats, reindex, index-all, embed, doctor.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["stats", "reindex", "index-all", "embed", "doctor"],
            description: "stats (default), reindex, index-all, embed, doctor.",
          },
          scope: { type: "string", enum: ["project", "all"], description: "embed/doctor: project (default) or all." },
          rebuild: { type: "boolean", description: "index-all: clear first (full rebuild)." },
        },
        additionalProperties: false,
      },
      async execute(raw, context) {
        const input = record(raw);
        const action = str(input, "action") ?? "stats";
        const scope = str(input, "scope") === "all" ? "all" : "project";
        const { projectID } = await currentProject(ctx, context.sessionID);

        if (action === "stats") {
          const [all, mine, summaries] = await Promise.all([
            runtime.index.count(),
            runtime.index.count(projectID),
            listSummaries(projectID, 1000),
          ]);
          const lines = [
            `backend: ${runtime.index.backend}${runtime.index.error ? ` (${runtime.index.error})` : ""}`,
            `project: ${projectID}`,
            `indexed documents: ${mine} in this project, ${all} total`,
            `summary files in this project: ${summaries.length}`,
          ];
          if (embedDisabled()) {
            lines.push("semantic layer: disabled (MEMORY_EMBED_DISABLED=1)");
          } else {
            const model = embedModelName();
            const embedded = await runtime.index.vectorCount(model).catch(() => 0);
            lines.push(`embedded vectors: ${embedded} document(s) (model: ${model})`);
          }
          return { content: lines.join("\n") };
        }

        if (action === "reindex") {
          const result = await reindexProject(runtime, projectID);
          return {
            content:
              `Reindexed project ${projectID}: ${result.sessions} sessions, ${result.messages} documents.` +
              (result.partial ? "\n> Partial: some sessions could only be read from the active context." : ""),
          };
        }

        if (action === "index-all") {
          const rebuild = bool(input, "rebuild", false);
          const result = await indexAllProjects(runtime, { currentProjectID: projectID, rebuild });
          const lines = result.projects.map(
            (project) =>
              `- \`${project.projectID}\`: ${project.sessions} session(s), ${project.messages} document(s)${
                project.partial ? " (partial)" : ""
              }`,
          );
          return {
            content:
              `Indexed ${result.totals.projects} project(s): ${result.totals.sessions} sessions, ${result.totals.messages} documents` +
              (rebuild ? " (full rebuild)" : " (incremental)") +
              `; ${result.summaries} summary file(s) on disk.\n\n${lines.join("\n")}`,
          };
        }

        if (action === "embed") {
          const engine = await getEngine();
          if (!engine) {
            return {
              content:
                `Vector engine unavailable${embedDisabled() ? " (MEMORY_EMBED_DISABLED=1)" : ""}. ` +
                `Model: ${embedModelName()}. Check the service logs; search stays keyword-only until it starts.`,
            };
          }
          const docs = await runtime.index.docs(scope === "project" ? projectID : undefined);
          const t0 = Date.now();
          const stats = await embedDocs(runtime, docs, engine);
          const pruned = await runtime.index.pruneOldVectors(engine.model);
          const vectors = await runtime.index.loadVectors(engine.model, scope === "project" ? projectID : undefined);
          const live = new Set(docs.map((doc) => doc.id));
          const orphans = [...vectors.keys()].filter((docID) => !live.has(docID));
          if (orphans.length > 0) await runtime.index.deleteVectors(orphans);
          return {
            content:
              `Vector index pass (scope: ${scope}): embedded ${stats.embedded} document(s), ${stats.skipped} unchanged, ` +
              `${stats.rehomed} re-bucketed after project moves, ` +
              `${pruned} old vector(s) from other model(s) removed, ` +
              `${orphans.length} orphan vector set(s) removed. ` +
              `model: ${engine.model}, dim: ${engine.spec.dim}, ${Date.now() - t0} ms. ` +
              `Documents in scope: ${docs.length}.`,
          };
        }

        if (action === "doctor") {
          const target = scope === "all" ? undefined : projectID;
          const lines: string[] = [
            `Checkup (${scope === "all" ? "all projects" : `project ${projectID}`}):`,
          ];
          const findings: string[] = [];

          lines.push(
            `- backend: ${runtime.index.backend}${runtime.index.error ? ` (error: ${runtime.index.error})` : " (healthy)"}`,
          );
          if (runtime.index.error) {
            findings.push(
              'backend error: restart OpenCode; if it persists, remove `index.db` from the memory data dir and run action="index-all" with rebuild=true.',
            );
          }

          const docs = await runtime.index.docs(target);
          const docIDs = new Set(docs.map((doc) => doc.id));
          const total = await runtime.index.count();
          lines.push(`- documents: ${docs.length} in scope, ${total} total`);

          const disk = target ? await listSummaries(target, 1000) : await listAllSummaries(1000);
          const diskIDs = new Set(disk.map((record) => record.messageID));
          const indexedIDs = new Set(
            (await runtime.index.summaryIDs(target)).map((id) => id.replace(/^summary:/, "")),
          );
          const missing = [...diskIDs].filter((id) => !indexedIDs.has(id));
          const stale = [...indexedIDs].filter((id) => !diskIDs.has(id));
          lines.push(`- summary files: ${disk.length} on disk, ${indexedIDs.size} indexed`);
          if (missing.length) {
            findings.push(`${missing.length} summary file(s) are not indexed: run action="reindex".`);
          }
          if (stale.length) {
            findings.push(`${stale.length} indexed summary entry(ies) have no file on disk: run action="reindex".`);
          }

          if (embedDisabled()) {
            lines.push("- vectors: disabled (MEMORY_EMBED_DISABLED=1)");
          } else {
            const model = embedModelName();
            const engine = await getEngine().catch(() => undefined);
            const embedded = await runtime.index.vectorCount(model, target).catch(() => 0);
            const coverage = docs.length > 0 ? Math.min(100, Math.round((embedded / docs.length) * 100)) : 100;
            lines.push(
              `- vectors: ${embedded}/${docs.length} document(s) embedded (${coverage}%, model ${model})`,
            );
            if (!engine) {
              findings.push(
                `vector engine unavailable: search stays keyword-only; run action="embed" once the service log shows the engine is up.`,
              );
            } else {
              const orphans = [...(await runtime.index.loadVectors(model, target).catch(() => new Map())).keys()].filter(
                (docID) => !docIDs.has(docID),
              );
              if (orphans.length) {
                findings.push(
                  `${orphans.length} vector set(s) belong to documents that no longer exist: run action="embed".`,
                );
              }
              if (embedded < docs.length) {
                findings.push(
                  `${docs.length - embedded} document(s) have no vector yet: run action="embed".`,
                );
              }
            }
          }

          const sessions = await listSessions(ctx, { projectID, scope, limit: 100, offset: 0 });
          const unindexed = sessions.filter((session) => !runtime.index.getSession(session.id));
          lines.push(
            `- sessions: ${sessions.length} listed, ${unindexed.length} without an index row` +
              (sessions.length >= 100 ? " (most recent 100 only)" : ""),
          );
          if (unindexed.length) {
            findings.push(
              `${unindexed.length} session(s) are not indexed: run action="${scope === "all" ? "index-all" : "reindex"}".`,
            );
          }

          lines.push(
            "Not checked: OpenCode's own database (sessions and projects are read through the official APIs), " +
              "content that is only in the active context, and disk usage.",
          );

          return {
            content: `${lines.join("\n")}\n\n${
              findings.length ? `Findings:\n${findings.map((finding) => `- ${finding}`).join("\n")}` : "No findings."
            }`,
          };
        }

        return { content: `Unknown action "${action}". Use stats, reindex, index-all, embed or doctor.` };
      },
      // Not pinned: maintenance is rare, so it stays behind one search() in
      // Code Mode while the three read tools keep the catalog budget.
      options: { namespace: "memory", pinned: false },
    });
  });
}
