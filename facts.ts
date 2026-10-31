/**
 * Persistent facts — rendered for injection and managed via the SQLite
 * `facts` table in `index.db` (SQLite WAL serialises writes across all
 * connections, so parallel `remember`/`forget` calls are safe by construction).
 *
 * Facts are id-based free text: the user's or agent's words ARE the value
 * (stored verbatim). ids are positive integers assigned by the table and are
 * never reused, so `/forget <id>` and in-place updates stay stable. Scope
 * convention: `machine` (default — injected in every session) or
 * `project:<name>` (injected only in sessions whose project directory
 * basename matches <name>).
 *
 * There is deliberately NO model pass at injection time: the injected text
 * is 1:1 with the store (ids included), so it stays verifiable against
 * `memory.facts list` and deterministic across sessions.
 */

import { basename } from "node:path";
import { clip, fmtDate } from "./util.js";
import { factsLoad, factsSet, factsRemove } from "./facts-db.js";
import { profileInjectLimit, profileSectionMax } from "./paths.js";

export { factsLoad } from "./facts-db.js";
export type { FactRow } from "./facts-db.js";

export const FACT_VALUE_MAX = 500;
export const FACT_CLIP = 300;

export interface PersistentFact {
  id: number;
  scope: string;
  value: string;
  updated: number;
  source: string;
}

export interface FactsDoc {
  version: 1;
  nextId: number;
  facts: PersistentFact[];
}

export interface FactsInjection {
  facts: PersistentFact[];
  omitted: number;
}

/**
 * Append a new fact (or replace one in place when `id` matches).
 * Returns the resulting document.
 */
export async function setFact(
  value: string,
  options: { scope?: string; id?: number; source?: string } = {},
): Promise<FactsDoc> {
  return factsSet(value, options);
}

/** Remove a fact by id. Throws if it does not exist. */
export async function removeFact(id: number): Promise<FactsDoc> {
  await factsRemove(id);
  return factsLoad();
}

/** Facts relevant to a session: machine + matching project, newest first. */
export function relevantFacts(doc: FactsDoc, projectDir?: string): PersistentFact[] {
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

/** Render facts for injection (quota-aware, never half-renders a line). */
export function factsInjection(doc: FactsDoc, projectDir?: string): FactsInjection {
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
  return { facts: rendered, omitted: relevant.length - rendered.length };
}

export function renderFactLine(fact: PersistentFact): string {
  const value = clip(fact.value.replace(/\s*\n\s*/g, " "), FACT_CLIP);
  const source = fact.source ? ` · by ${fact.source}` : "";
  return `#${fact.id} [${fact.scope}] ${value} · updated ${fmtDate(fact.updated)}${source}`;
}

/** The rendered `<memory-context>` section; `undefined` when nothing fits. */
export function factsSection(injection: FactsInjection): string | undefined {
  if (injection.facts.length === 0) return undefined;
  const lines = injection.facts.map((fact) => `- ${renderFactLine(fact)}`);
  if (injection.omitted > 0) {
    lines.push(`… (${injection.omitted} more fact(s) not shown — quota reached; use memory.facts list for the full list)`);
  }
  return lines.join("\n");
}

export function resolveScope(scope: string | undefined, projectDir?: string): string {
  const clean = (scope ?? "machine").trim() || "machine";
  if (clean === "machine" || clean.startsWith("project:")) return clean;
  const projectName = projectDir ? basename(projectDir.replace(/[\\/]+$/, "")).toLowerCase() : "";
  if (clean === "project") return projectName ? `project:${projectName}` : "machine";
  return "machine";
}
