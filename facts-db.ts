/**
 * Persistent facts stored in the memory index database (`index.db`), in a
 * dedicated `facts` table. SQLite WAL serialises writes across all
 * connections, so parallel `remember`/`forget` calls (subagent batched tool
 * calls) are safe by construction — no in-process mutex needed.
 *
 * The table schema is additive to the index DB; the migration from the
 * legacy `facts.json` / `profile.json` files runs once (lazily) and deletes
 * the source files on success.
 */

import { join } from "node:path";
import { dataRoot, factsPath, legacyFactsPath } from "./paths.js";
import { atomicWrite, readText } from "./storage.js";

/** The on-disk document (facts table row shape). */
export interface FactRow {
  id: number;
  scope: string;
  value: string;
  updated: number;
  source: string;
}

export interface FactsDoc {
  version: 1;
  nextId: number;
  facts: FactRow[];
}

let _db: any | null = null;
let _initPromise: Promise<any> | null = null;

const FACT_VALUE_MAX = 500;

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  value TEXT NOT NULL,
  updated INTEGER NOT NULL,
  source TEXT
)`;

async function getDb(): Promise<any> {
  if (_db) return _db;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const { Database } = await import("bun:sqlite");
    const path = join(dataRoot(), "index.db");
    _db = new Database(path, { create: true });
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA busy_timeout = 5000");
    _db.exec(TABLE_SQL);
    return _db;
  })().catch((err) => {
    _initPromise = null;
    throw err;
  });
  return _initPromise;
}

/** Parse a legacy JSON document into rows. */
function parseLegacyJson(raw: string | undefined): FactRow[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const facts = Array.isArray((parsed as { facts?: unknown }).facts) ? (parsed as { facts: unknown[] }).facts : [];
    const rows: FactRow[] = [];
    let nextId = 1;
    for (const entry of facts) {
      if (typeof entry !== "object" || entry === null) continue;
      const id = Number((entry as Record<string, unknown>).id);
      const value = String((entry as Record<string, unknown>).value ?? "").replace(/\s+/g, " ").trim();
      if (!Number.isInteger(id) || id < 1 || !value) continue;
      const row: FactRow = {
        id,
        scope: String((entry as Record<string, unknown>).scope ?? "machine").trim() || "machine",
        value,
        updated: Number.isFinite(Number((entry as Record<string, unknown>).updated)) ? Number((entry as Record<string, unknown>).updated) : 0,
        source: String((entry as Record<string, unknown>).source ?? ""),
      };
      rows.push(row);
      if (id >= nextId) nextId = id + 1;
    }
    rows.sort((a, b) => a.id - b.id);
    return rows;
  } catch {
    return [];
  }
}

/**
 * One-time migration: if the `facts` table is empty and a legacy JSON file
 * exists, import its rows and delete the JSON. No-op when the table is
 * already populated.
 */
async function migrateFromJson(db: any): Promise<void> {
  const existing = db.query("SELECT COUNT(*) AS n FROM facts").get() as { n: number };
  if (Number(existing.n) > 0) return;

  const rows = parseLegacyJson(await readText(factsPath()));
  if (rows.length === 0) return;

  const legacy = parseLegacyJson(await readText(legacyFactsPath()));
  // Merge: existing table rows + facts.json + profile.json (newest `updated` per id)
  const byId = new Map<number, FactRow>();
  const all = [...rows, ...legacy];
  for (const row of all) {
    const current = byId.get(row.id);
    if (current && current.updated > row.updated) continue;
    byId.set(row.id, row);
  }

  const insert = db.query("INSERT OR REPLACE INTO facts (id, scope, value, updated, source) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const row of byId.values()) {
      insert.run(row.id, row.scope, row.value, row.updated, row.source);
    }
  })();

  // Delete source files (they are now superseded by the table).
  void import("node:fs/promises").then(async ({ rm }) => {
    await rm(factsPath(), { force: true, recursive: false }).catch(() => undefined);
    await rm(legacyFactsPath(), { force: true, recursive: false }).catch(() => undefined);
  });
}

/** All facts from the table, oldest id first. */
export async function factsLoad(): Promise<FactsDoc> {
  const db = await getDb();
  await migrateFromJson(db);
  const rows = db
    .query("SELECT id, scope, value, updated, source FROM facts ORDER BY id")
    .all() as Array<{ id: number; scope: string; value: string; updated: number; source: string | null }>;
  if (rows.length === 0) return { version: 1, nextId: 1, facts: [] };
  return {
    version: 1,
    nextId: rows.reduce((max, r) => Math.max(max, r.id), 0) + 1,
    facts: rows.map((r) => ({ id: r.id, scope: r.scope, value: r.value, updated: r.updated, source: r.source ?? "" })),
  };
}

/**
 * Insert a new fact or update an existing one in place (when `id` matches).
 * Returns the resulting document.
 */
export async function factsSet(
  value: string,
  options: { scope?: string; id?: number; source?: string } = {},
): Promise<FactsDoc> {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("value is empty");
  if (clean.length > FACT_VALUE_MAX) {
    throw new Error(`value is ${clean.length} chars (max ${FACT_VALUE_MAX}); shorten it`);
  }
  const scope = (options.scope ?? "machine").trim() || "machine";
  if (scope !== "machine" && !scope.startsWith("project:")) {
    throw new Error(`scope must be "machine" or "project:<name>" (got "${scope}")`);
  }
  const now = Date.now();
  const source = options.source ?? "user:/remember";
  const db = await getDb();

  db.transaction(() => {
    if (options.id !== undefined) {
      const count = db
        .query("UPDATE facts SET value = ?, scope = ?, updated = ?, source = ? WHERE id = ? RETURNING id")
        .run(clean, scope, now, source, options.id) as { changes: number };
      if (count.changes === 0) throw new Error(`no fact with id ${options.id}`);
    } else {
      const nextId = db
        .query("SELECT COALESCE(MAX(id), 0) + 1 AS next FROM facts")
        .get() as { next: number };
      db
        .query("INSERT INTO facts (id, scope, value, updated, source) VALUES (?, ?, ?, ?, ?)")
        .run(nextId.next, scope, clean, now, source);
    }
  })();

  return factsLoad();
}

/** Remove a fact by id. Throws if it does not exist. */
export async function factsRemove(id: number): Promise<void> {
  const db = await getDb();
  const result = db.query("DELETE FROM facts WHERE id = ? RETURNING id").run(id) as { changes: number };
  if (result.changes === 0) throw new Error(`no fact with id ${id}`);
}

/**
 * Clear all facts (used in tests). Throws if the table is empty (no-op is fine).
 */
export async function clearFacts(): Promise<void> {
  const db = await getDb();
  db.exec("DELETE FROM facts");
}

/** All facts from the table, oldest id first. */
export async function factsLoadAll(): Promise<FactsDoc> {
  return factsLoad();
}
