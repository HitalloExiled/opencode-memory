/**
 * Shared hybrid search (FTS5 + local vectors, fused by RRF).
 *
 * The `memory.search` tool and the GUI RPC both call this function so they
 * return the same ranking and the same `via` attribution. Pagination is
 * offset-based: the index returns a window of candidates, fusion happens over
 * that window, and only then the requested page is sliced out.
 */

import { cosine, getEngine, rrfFuse } from "../embed.js";
import { backfillProject, indexSummaryFiles } from "../indexer.js";
import { embedDisabled } from "../paths.js";
import type { Runtime } from "../runtime.js";
import type { MessageKind, SearchHit } from "../types.js";
import { fmtDate, normalizeWhitespace, snippet, tokenize } from "../util.js";

export interface SearchMemoryOptions {
  projectID?: string | undefined;
  scope: "project" | "all";
  query: string;
  kind?: MessageKind | "any" | undefined;
  /** Restrict to several kinds (the GUI uses user + assistant). */
  kinds?: MessageKind[] | undefined;
  /** Inclusive lower/upper bounds on the document's created time (epoch ms). */
  since?: number | undefined;
  until?: number | undefined;
  /** Page size (the GUI uses 20; the tool caps at 50). */
  limit: number;
  /** Number of ranked hits to skip. */
  offset?: number | undefined;
  /** Run the lazy backfill first. Off for pages after the first. */
  backfill?: boolean | undefined;
}

export interface SearchMemoryResult {
  hits: SearchHit[];
  hasMore: boolean;
  /** Some sessions could only be read from the active context. */
  partial: boolean;
  /** A user-facing note when the semantic layer was unavailable. */
  vectorNote?: string | undefined;
}

/** Keep the candidate window bounded even if a caller paginates deeply. */
const MAX_WINDOW = 200;

export async function searchMemory(runtime: Runtime, options: SearchMemoryOptions): Promise<SearchMemoryResult> {
  const kind = options.kind ?? "any";
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  // One extra hit tells us whether another page exists.
  const window = Math.min(MAX_WINDOW, offset + limit + 1);

  let partial = false;
  if (options.backfill !== false) {
    if (options.scope === "all") {
      await indexSummaryFiles(runtime).catch(() => 0);
      if (options.projectID) await backfillProject(runtime, options.projectID).catch(() => undefined);
    } else if (options.projectID) {
      const result = await backfillProject(runtime, options.projectID).catch(() => undefined);
      if (result?.partial) partial = true;
    }
  }

  const terms = tokenize(options.query);
  const kindSet = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : undefined;
  const ftsHits = await runtime.index.search(options.query, {
    projectID: options.projectID,
    scope: options.scope,
    kind,
    kinds: options.kinds,
    since: options.since,
    until: options.until,
    limit: window * 3,
  });

  let vecHits: Array<{ id: string; score: number }> = [];
  let vectorNote: string | undefined;
  if (!embedDisabled()) {
    const engine = await getEngine();
    if (!engine) {
      vectorNote = "> Vector layer unavailable; results are keyword-only.";
    } else {
      try {
        const qvec = await engine.embedText(engine.spec.queryPrefix + options.query);
        const vectors = await runtime.index.loadVectors(
          engine.model,
          options.scope === "project" ? options.projectID : undefined,
        );
        for (const [id, entry] of vectors) {
          if (kindSet ? !kindSet.has(entry.kind) : kind !== "any" && entry.kind !== kind) continue;
          if (options.since !== undefined && entry.created < options.since) continue;
          if (options.until !== undefined && entry.created > options.until) continue;
          let best = -Infinity;
          for (const vec of entry.vecs) {
            const score = cosine(qvec, vec);
            if (score > best) best = score;
          }
          if (best > -Infinity) vecHits.push({ id, score: best });
        }
        vecHits.sort((a, b) => b.score - a.score);
        vecHits = vecHits.slice(0, window * 3);
      } catch (error) {
        vectorNote = `> Vector layer failed (${error instanceof Error ? error.message : String(error)}); results are keyword-only.`;
      }
    }
  }

  let fused: SearchHit[];
  if (vecHits.length === 0) {
    fused = ftsHits.map((hit) => ({ ...hit, via: "fts" as const }));
  } else {
    const ranked = rrfFuse(
      ftsHits.map((hit) => hit.id),
      vecHits.map((hit) => hit.id),
      window,
    );
    const byFts = new Map(ftsHits.map((hit) => [hit.id, hit]));
    const missing = ranked.filter((entry) => !byFts.has(entry.id)).map((entry) => entry.id);
    const extras = missing.length > 0 ? await runtime.index.docsByIds(missing) : [];
    const byDoc = new Map(extras.map((doc) => [doc.id, doc]));
    fused = ranked
      .map((entry): SearchHit | undefined => {
        const doc = byFts.get(entry.id) ?? byDoc.get(entry.id);
        if (!doc) return undefined;
        return {
          ...doc,
          rank: byFts.get(entry.id)?.rank ?? 0,
          snippet: snippet(doc.text, terms),
          via: entry.via,
        };
      })
      .filter((hit): hit is SearchHit => hit !== undefined);
  }

  const page = fused.slice(offset, offset + limit);
  return {
    hits: page,
    hasMore: fused.length > offset + limit,
    partial,
    ...(vectorNote ? { vectorNote } : {}),
  };
}

/**
 * One line per hit, with the id that `memory.history action="message"` needs.
 * Every narrative doc stores its message id in `messageID`; summary docs carry
 * `messageID` without the `summary:` index prefix, so quoting stays a lookup
 * instead of a search.
 */
export function formatSearchHits(hits: SearchHit[], sessionID?: string): string[] {
  return hits.map((hit) => {
    const session = sessionID && hit.sessionID === sessionID ? "this session" : `\`${hit.sessionID}\``;
    const by =
      hit.kind === "user"
        ? "user"
        : [hit.agent, hit.model ? `(${hit.model})` : ""].filter(Boolean).join(" ");
    const messageID = hit.messageID ?? hit.id;
    return (
      `- **${fmtDate(hit.created)}** · ${hit.kind}` +
      `${by ? ` · by: ${by}` : ""} · via: ${hit.via ?? "fts"} · ${session} · \`${messageID}\`` +
      `${hit.title ? ` — ${hit.title}` : ""}` +
      `\n  ${normalizeWhitespace(hit.snippet)}`
    );
  });
}
