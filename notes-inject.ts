/**
 * Long-term notes (the `notes` layer) scanned for session injection.
 *
 * Standalone-pure by design: this module knows only WHERE the notes database
 * lives (a sibling of the plugin's own data dir, when the machine runs the
 * notes system) and the read-only SQL it runs. If the database is absent,
 * unreadable, or the machine has no notes system at all, the injection simply
 * carries no notes section — every consumer degrades gracefully.
 *
 * Relevance without a query: notes are scoped by convention
 * (Scope: global | project:<name> | machine:<name>). A note is relevant to a
 * session when its scope names the session's project directory or this
 * machine. Global notes are deliberately excluded: they are too broad for
 * per-session injection and stay one notes.search away.
 */

import { existsSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename, join } from "node:path";

import { dataRoot } from "./paths.js";
import { clip } from "./util.js";

/** One note as the injection consumes it. */
export interface NoteForInjection {
  id: number;
  category: string;
  title: string;
  scope: string;
  updatedAt: string;
  author?: string;
  disputed: boolean;
  content: string;
}

/** MEMORY_NOTES_INJECT: how many relevant notes to inject ("0" disables). */
export function notesInjectLimit(): number {
  const value = Number(process.env.MEMORY_NOTES_INJECT ?? "3");
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 3;
}

function notesDbPath(): string {
  return join(dataRoot(), "notes.db");
}

type Db = { prepare: (sql: string) => { all: () => unknown[] }; close: () => void };

async function openNotesDb(): Promise<Db | null> {
  const path = notesDbPath();
  if (!existsSync(path)) return null;
  try {
    const mod: any = await import("bun:sqlite");
    const Database = mod?.Database;
    if (typeof Database === "function") return new Database(path, { readonly: true });
  } catch {
    /* fall through to node:sqlite */
  }
  try {
    const mod: any = await import("node:sqlite");
    const Database = mod?.DatabaseSync;
    if (typeof Database === "function") return new Database(path, { readOnly: true });
  } catch {
    /* fall through */
  }
  return null;
}

/** The note's declared scope: the first `Scope: <value>` line in its content. */
export function scopeOf(content: string): string {
  const match = content.match(/^\s*Scope:\s*(\S+)/m);
  return match?.[1] ?? "";
}

/** Names that identify this machine: hostname and the user account (whole and first part). */
function machineIdentifiers(): string[] {
  const user = (userInfo()?.username ?? "").toLowerCase();
  const first = user.split(".")[0] ?? "";
  return [hostname().toLowerCase(), user, first].filter(Boolean);
}

function scopeMatches(scope: string, projectName: string, host: string[]): boolean {
  if (!scope) return false;
  const [kind, name] = scope.split(":");
  if (kind === "project") return name !== undefined && name.toLowerCase() === projectName.toLowerCase();
  if (kind === "machine") return name === undefined || host.includes(name.toLowerCase());
  return false; // global / unknown scopes are too broad for per-session injection
}

/**
 * Relevant notes for a session: scoped to the session's project directory
 * name or this machine, never retracted, most recent first, capped at
 * MEMORY_NOTES_INJECT. Disputed notes are kept (flagged) — a suspect note is
 * still a lead, not noise.
 */
export async function relevantNotes(projectDir?: string): Promise<NoteForInjection[]> {
  const limit = notesInjectLimit();
  if (limit === 0) return [];
  const db = await openNotesDb();
  if (!db) return [];
  const host = machineIdentifiers();
  const projectName = projectDir ? basename(projectDir.replace(/[\\/]+$/, "")) : "";
  try {
    // Scope lives in the note content, so filter in JS over the most recent
    // notes. Retraction is a column (trust lifecycle), not content.
    const rows = db
      .prepare(
        `SELECT id, category, title, content, timestamp, author, disputed_at
         FROM notes
         WHERE retracted_at IS NULL
         ORDER BY timestamp DESC
         LIMIT 200`,
      )
      .all() as Array<Record<string, unknown>>;
    const matched: NoteForInjection[] = [];
    for (const row of rows) {
      const content = String(row.content ?? "");
      const scope = scopeOf(content);
      if (!scopeMatches(scope, projectName, host)) continue;
      matched.push({
        id: Number(row.id),
        category: String(row.category ?? ""),
        title: String(row.title ?? ""),
        scope,
        updatedAt: String(row.timestamp ?? ""),
        author: row.author ? String(row.author) : undefined,
        disputed: row.disputed_at != null,
        content,
      });
      if (matched.length >= limit) break;
    }
    return matched;
  } finally {
    db.close();
  }
}

const NOTE_CONTENT_MAX = 600;

/** Render the notes section for <memory-context>; undefined when empty. */
export function notesSection(notes: NoteForInjection[]): string | undefined {
  if (notes.length === 0) return undefined;
  return notes
    .map((note) => {
      const meta = [
        `scope: ${note.scope}`,
        `updated: ${note.updatedAt}`,
        note.author ? `by ${note.author}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      const body = clip(note.content.replace(/\s*\n\s*/g, " "), NOTE_CONTENT_MAX);
      return [
        `- #${note.id} [${note.category}]${note.disputed ? " ⚠ disputed" : ""} ${note.title}`,
        `  ${meta}`,
        `  ${body}`,
      ].join("\n");
    })
    .join("\n\n");
}
