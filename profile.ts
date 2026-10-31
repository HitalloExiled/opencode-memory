/**
 * Persistent memory (profile): durable facts about the surrounding world
 * that keep being true after the session ends — who the user is, their
 * preferences, ongoing work, machine facts. Small, current, and always
 * injected at session start (replacing the former relevant-notes section).
 *
 * Standalone-pure by design: this module owns `facts.json` (legacy name
 * `profile.json`) under the plugin's data root (a sibling of the notes DB
 * when the machine runs the notes system). If the file is missing, unreadable,
 * or malformed, every
 * consumer degrades gracefully: the injection carries no profile section
 * and the tools report an empty store.
 *
 * Facts are id-based free text: the user's or agent's words ARE the value
 * (stored verbatim). ids are positive integers assigned by `nextId` and are
 * never reused, so `/forget <id>` and in-place updates stay stable. Scope
 * convention (same as the notes' `Scope:` line): `machine` (default —
 * injected in every session) or `project:<name>` (injected only in sessions
 * whose project directory basename matches <name>).
 *
 * There is deliberately NO model pass at injection time: the injected text
 * is 1:1 with the store (ids included), so it stays verifiable against
 * `memory.facts list` and deterministic across sessions. Facts are
 * digested where they are written (the agent's set calls and the /remember
 * command keep them short and deduplicated), not when they are read back.
 */

import { basename } from "node:path";

import { factsPath, legacyFactsPath, profileInjectLimit, profileSectionMax } from "./paths.js";
import { atomicWrite, readText } from "./storage.js";
import { clip, fmtDate, isRecord, normalizeWhitespace } from "./util.js";

/** Max value length accepted at write time (injection clips to FACT_CLIP). */
export const FACT_VALUE_MAX = 500;

/** Per-fact clip for injection. */
export const FACT_CLIP = 300;

/** One durable fact as the store keeps it. */
export interface PersistentFact {
  id: number;
  scope: string; // "machine" or "project:<name>"
  value: string;
  updated: number; // milliseconds
  source: string; // "user:/remember" | "ses_..." (who established it)
}

/** The on-disk document (profile.json). */
export interface ProfileDoc {
  version: 1;
  nextId: number;
  facts: PersistentFact[];
}

/** Rendered facts for the injection, plus what the budget left out. */
export interface ProfileInjection {
  facts: PersistentFact[];
  omitted: number;
}

/** Build a fresh, always-writable empty document (never a shared instance). */
function emptyDoc(): ProfileDoc {
  return { version: 1, nextId: 1, facts: [] };
}

/**
 * Parse and validate the raw document; any malformity yields a fresh empty
 * doc. A valid document with no (or no valid) facts also yields a fresh
 * empty doc — setFact/removeFact mutate the doc they are given, so it must
 * never be a shared constant.
 */
function parseDoc(raw: string | undefined): ProfileDoc {
  if (!raw) return emptyDoc();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return emptyDoc();
    const facts: PersistentFact[] = [];
    let nextId = 1;
    for (const entry of Array.isArray(parsed.facts) ? parsed.facts : []) {
      if (!isRecord(entry)) continue;
      const id = Number(entry.id);
      if (!Number.isInteger(id) || id < 1) continue;
      const value = normalizeWhitespace(String(entry.value ?? ""));
      if (!value) continue;
      const scope = String(entry.scope ?? "machine").trim() || "machine";
      const updated = Number.isFinite(Number(entry.updated)) ? Number(entry.updated) : 0;
      const source = entry.source ? String(entry.source) : "";
      facts.push({ id, scope, value, updated, source });
      if (id >= nextId) nextId = id + 1;
    }
    return { version: 1, nextId, facts };
  } catch {
    return emptyDoc();
  }
}

/** Load the store (missing/unreadable file yields the empty doc). With no
 * explicit path, if facts.json is empty but the pre-rename profile.json
 * still exists, its facts are merged in (by id, keeping the newest
 * `updated`) — a one-time lazy migration. */
export async function loadProfile(path?: string): Promise<ProfileDoc> {
  const doc = parseDoc(await readText(path ?? factsPath()));
  if (path === undefined && doc.facts.length === 0) {
    const legacy = parseDoc(await readText(legacyFactsPath()));
    if (legacy.facts.length > 0) {
      const byId = new Map(doc.facts.map((f) => [f.id, f]));
      for (const fact of legacy.facts) {
        const existing = byId.get(fact.id);
        if (existing) {
          if (fact.updated > existing.updated) byId.set(fact.id, fact);
        } else {
          doc.facts.push(fact);
          byId.set(fact.id, fact);
        }
      }
      doc.facts = [...byId.values()].sort((a, b) => a.id - b.id);
    }
  }
  return doc;
}

/** Atomic save (temp file + rename); mode 0600 like the rest of the data. */
export async function saveProfile(doc: ProfileDoc, path?: string): Promise<void> {
  await atomicWrite(path ?? factsPath(), JSON.stringify(doc, null, 2) + "\n");
}

/**
 * Append a new fact (or replace one in place when `id` matches). Returns the
 * resulting document, or throws when the value is empty or too long.
 */
export async function setFact(
  value: string,
  options: { scope?: string; id?: number; source?: string; path?: string },
): Promise<ProfileDoc> {
  const doc = await loadProfile(options.path);
  const clean = normalizeWhitespace(value);
  if (!clean) throw new Error("value is empty");
  if (clean.length > FACT_VALUE_MAX) {
    throw new Error(`value is ${clean.length} chars (max ${FACT_VALUE_MAX}); shorten it`);
  }
  const scope = (options.scope ?? "machine").trim() || "machine";
  if (scope !== "machine" && !scope.startsWith("project:")) {
    throw new Error(`scope must be "machine" or "project:<name>" (got "${scope}")`);
  }
  const now = Date.now();
  if (options.id !== undefined) {
    const target = doc.facts.find((fact) => fact.id === options.id);
    if (!target) throw new Error(`no fact with id ${options.id}`);
    target.value = clean;
    target.scope = scope;
    target.updated = now;
    target.source = options.source ?? "ses_update";
  } else {
    doc.facts.push({ id: doc.nextId, scope, value: clean, updated: now, source: options.source ?? "user:/remember" });
    doc.nextId += 1;
  }
  await saveProfile(doc, options.path);
  return doc;
}

/** Remove a fact by id. Returns the resulting document. */
export async function removeFact(id: number, options: { path?: string } = {}): Promise<ProfileDoc> {
  const doc = await loadProfile(options.path);
  const before = doc.facts.length;
  doc.facts = doc.facts.filter((fact) => fact.id !== id);
  if (doc.facts.length === before) throw new Error(`no fact with id ${id}`);
  await saveProfile(doc, options.path);
  return doc;
}

/**
 * Facts relevant to a session: machine facts plus facts whose project scope
 * names the session's project directory basename (case-insensitive).
 * Newest first (by `updated`).
 */
export function relevantFacts(doc: ProfileDoc, projectDir?: string): PersistentFact[] {
  const projectName = projectDir ? basename(projectDir.replace(/[\\/]+$/, "")).toLowerCase() : "";
  return doc.facts
    .filter((fact) => {
      if (fact.scope === "machine") return true;
      if (fact.scope.startsWith("project:")) {
        return fact.scope.slice("project:".length).toLowerCase() === projectName;
      }
      return false;
    })
    .sort((a, b) => b.updated - a.updated);
}

/**
 * Render the facts for the injection: relevant, newest first, capped at
 * profileInjectLimit facts and profileSectionMax chars in total. A fact whose
 * clipped line would not fit is omitted entirely (never half-rendered).
 */
export function profileInjection(doc: ProfileDoc, projectDir?: string): ProfileInjection {
  const limit = profileInjectLimit();
  if (limit === 0) return { facts: [], omitted: 0 };
  const max = profileSectionMax();
  const relevant = relevantFacts(doc, projectDir);
  const candidates = relevant.slice(0, limit);
  const rendered: PersistentFact[] = [];
  let used = 0;
  for (const fact of candidates) {
    const line = renderFactLine(fact);
    const cost = line.length + (rendered.length > 0 ? 2 : 0);
    if (used + cost > max) break;
    rendered.push(fact);
    used += cost;
  }
  // Everything not rendered — whether cut by the fact cap or the char budget.
  return { facts: rendered, omitted: relevant.length - rendered.length };
}

/** One rendered fact line (value clipped to FACT_CLIP). */
export function renderFactLine(fact: PersistentFact): string {
  const value = clip(fact.value.replace(/\s*\n\s*/g, " "), FACT_CLIP);
  const source = fact.source ? ` · by ${fact.source}` : "";
  return `#${fact.id} [${fact.scope}] ${value} · updated ${fmtDate(fact.updated)}${source}`;
}


/** The rendered section for <memory-context>; undefined when nothing fits. */
export function profileSection(injection: ProfileInjection): string | undefined {
  if (injection.facts.length === 0) return undefined;
  const lines = injection.facts.map((fact) => `- ${renderFactLine(fact)}`);
  if (injection.omitted > 0) {
    lines.push(`… (${injection.omitted} more fact(s) not shown — quota reached; use memory.facts list for the full list)`);
  }
  return lines.join("\n");
}

/** Resolve a scope argument: "machine" | "project" (current project) | "project:<name>". */
export function resolveScope(scope: string | undefined, projectDir?: string): string {
  const clean = (scope ?? "machine").trim() || "machine";
  if (clean === "machine" || clean.startsWith("project:")) return clean;
  const projectName = projectDir ? basename(projectDir.replace(/[\\/]+$/, "")) : "";
  if (clean === "project") return projectName ? `project:${projectName}` : "machine";
  return "machine";
}
