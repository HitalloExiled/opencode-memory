import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Runtime } from "../runtime.js";
import { formatSearchHits, searchMemory } from "../src/search.js";
import type { SearchHit } from "../types.js";

const docs: SearchHit[] = [1, 2, 3, 4].map((n) => ({
  id: `m${n}`,
  projectID: "p1",
  sessionID: "s1",
  messageID: `m${n}`,
  kind: "user",
  created: n,
  text: `document ${n}`,
  snippet: `document ${n}`,
  rank: n,
}));

function fakeRuntime(): Runtime {
  return {
    index: {
      backend: "sqlite-fts5",
      search: async (_query: string, options: { limit: number }) => docs.slice(0, options.limit),
      loadVectors: async () => new Map(),
      docsByIds: async () => [],
    },
  } as unknown as Runtime;
}

beforeAll(() => {
  process.env.MEMORY_EMBED_DISABLED = "1";
});

afterAll(() => {
  delete process.env.MEMORY_EMBED_DISABLED;
});

describe("searchMemory pagination", () => {
  test("slices the fused ranking and reports hasMore", async () => {
    const runtime = fakeRuntime();
    const first = await searchMemory(runtime, {
      projectID: "p1",
      scope: "project",
      query: "document",
      limit: 2,
      offset: 0,
      backfill: false,
    });
    expect(first.hits.map((hit) => hit.id)).toEqual(["m1", "m2"]);
    expect(first.hasMore).toBe(true);
    expect(first.partial).toBe(false);

    const second = await searchMemory(runtime, {
      projectID: "p1",
      scope: "project",
      query: "document",
      limit: 2,
      offset: 2,
      backfill: false,
    });
    expect(second.hits.map((hit) => hit.id)).toEqual(["m3", "m4"]);
    expect(second.hasMore).toBe(false);
  });

  test("returns an empty page past the end", async () => {
    const result = await searchMemory(fakeRuntime(), {
      projectID: "p1",
      scope: "project",
      query: "document",
      limit: 2,
      offset: 10,
      backfill: false,
    });
    expect(result.hits).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  test("does not report hasMore when the page is exactly the end", async () => {
    const result = await searchMemory(fakeRuntime(), {
      projectID: "p1",
      scope: "project",
      query: "document",
      limit: 4,
      offset: 0,
      backfill: false,
    });
    expect(result.hits).toHaveLength(4);
    expect(result.hasMore).toBe(false);
  });
});

describe("formatSearchHits", () => {
  const base: SearchHit = docs[0]!;
  const hit = (over: Partial<SearchHit>): SearchHit => ({ ...base, ...over });

  test("prints the message id so action=message is one lookup away", () => {
    const [line] = formatSearchHits([hit({ sessionID: "s1", title: "A title" })], "s1");
    expect(line).toContain("this session");
    expect(line).toContain("`m1`");
    expect(line).toContain("A title");
  });

  test("summary hits show the message id without the index prefix", () => {
    const [line] = formatSearchHits(
      [hit({ sessionID: "s9", id: "summary:msg_x", messageID: "msg_x", kind: "summary" })],
      "s1",
    );
    expect(line).toContain("`s9`");
    expect(line).toContain("`msg_x`");
    expect(line).not.toContain("`summary:msg_x`");
  });

  test("falls back to the document id when messageID is absent", () => {
    const [line] = formatSearchHits([hit({ id: "doc1", messageID: undefined })], "s1");
    expect(line).toContain("`doc1`");
  });
});

describe("searchMemory date window", () => {
  test("forwards since/until to the index", async () => {
    const seen: Array<{ since?: number; until?: number }> = [];
    const runtime = {
      index: {
        backend: "sqlite-fts5",
        search: async (_query: string, options: { limit: number; since?: number; until?: number }) => {
          seen.push({ since: options.since, until: options.until });
          return docs.slice(0, options.limit);
        },
        loadVectors: async () => new Map(),
        docsByIds: async () => [],
      },
    } as unknown as Runtime;

    await searchMemory(runtime, {
      projectID: "p1",
      scope: "project",
      query: "document",
      limit: 2,
      since: 1500,
      until: 2500,
      backfill: false,
    });
    expect(seen[0]).toEqual({ since: 1500, until: 2500 });
  });
});
