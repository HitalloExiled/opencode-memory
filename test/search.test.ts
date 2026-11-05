import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Runtime } from "../runtime.js";
import { searchMemory } from "../src/search.js";
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
