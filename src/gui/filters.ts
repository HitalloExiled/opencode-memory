/**
 * Pure view helpers for the Memory panel: grouping, highlighting and the
 * exact quote text that is attached to the composer. Kept free of Solid and
 * host APIs so they can be unit-tested.
 */

import type { HitView } from "./contract.js";

export interface SessionGroup {
  sessionID: string;
  projectID: string;
  title?: string | undefined;
  updated: number;
  /** First `maxSnippets` matches, best-ranked first. */
  hits: HitView[];
  /** Total matches in this session across the loaded pages. */
  total: number;
}

/** Group ranked hits by session, preserving first-appearance order. */
export function groupHitsBySession(hits: readonly HitView[], maxSnippets = 3): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const hit of hits) {
    let group = groups.get(hit.sessionID);
    if (!group) {
      group = {
        sessionID: hit.sessionID,
        projectID: hit.projectID,
        ...(hit.title ? { title: hit.title } : {}),
        updated: hit.created,
        hits: [],
        total: 0,
      };
      groups.set(hit.sessionID, group);
    }
    group.total++;
    group.updated = Math.max(group.updated, hit.created);
    if (group.hits.length < maxSnippets) group.hits.push(hit);
  }
  return [...groups.values()];
}

/** Lowercase query terms used for highlighting (same shape as the index tokenizer). */
export function termsOf(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (raw.length < 2 || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** Append a page of hits, dropping ids already present. */
export function mergeHits(previous: readonly HitView[], next: readonly HitView[]): HitView[] {
  const seen = new Set(previous.map((hit) => hit.id));
  return [...previous, ...next.filter((hit) => !seen.has(hit.id))];
}

export interface HighlightPart {
  text: string;
  match: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split `text` into plain/marked segments for the query terms. */
export function highlightParts(text: string, terms: readonly string[]): HighlightPart[] {
  const clean = terms.map((term) => term.trim()).filter((term) => term.length > 0);
  if (clean.length === 0 || !text) return [{ text, match: false }];
  const pattern = new RegExp(`(${clean.map(escapeRegExp).join("|")})`, "gi");
  const pieces = text.split(pattern);
  return pieces
    .map((piece, index) => ({ text: piece, match: index % 2 === 1 }))
    .filter((part) => part.text.length > 0);
}

export type Translate = (key: string, ...args: unknown[]) => string;

export function formatCharsRange(start: number, end: number, total: number, t: Translate): string {
  return t("quote.chars", start, end, total);
}

function isoDate(ms: number, t: Translate): string {
  if (!ms) return t("quote.unknownDate");
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return t("quote.unknownDate");
  return date.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export interface QuoteInput {
  sessionID: string;
  messageID: string;
  title?: string | undefined;
  kind: string;
  created: number;
  text: string;
  total: number;
  offset: number;
  length: number;
  start: number;
  end: number;
  limit: number;
  query?: string | undefined;
  /** The text is the user's selection, not a computed window. */
  selected?: boolean | undefined;
}

/**
 * The text attached to the composer. It always carries the total size and the
 * offset of the slice, plus the exact tool call the agent can use to read
 * around the occurrence. Every label comes from the panel's translation table.
 */
export function buildQuote(input: QuoteInput, t: Translate): string {
  const title = input.title?.trim() || input.sessionID;
  const occurrence = input.query?.trim() ? ` · ${t("quote.occurrence", input.query.trim())}` : "";
  const selected = input.selected ? ` ${t("quote.selected")}` : "";
  const header = [
    `[${t("quote.tag")}] ${title} · ${t("quote.session")} ${input.sessionID} · ${t("quote.message")} ${input.messageID} · ${input.kind} · ${isoDate(input.created, t)}${occurrence}${selected}`,
    t("quote.range", formatCharsRange(input.start, input.end, input.total, t), input.offset, input.length, input.limit),
    `${t("quote.around")} memory.history action="message" sessionID="${input.sessionID}" messageID="${input.messageID}" charOffset=${input.start} charLimit=${input.limit}`,
  ];
  return `${header.join("\n")}\n\n${input.text}`;
}
