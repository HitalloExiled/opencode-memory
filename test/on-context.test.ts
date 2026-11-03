/**
 * Regression: the memory block must be present on EVERY agent-loop request,
 * with identical bytes.
 *
 * The server rebuilds `system` from scratch for each request, so a block that
 * is pushed only on the first one disappears on the next turn. That shortens
 * the head of the prompt by ~1.9K chars at ~6.9K tokens, which drops the slot's
 * LCP similarity below 0.100 and forces a full re-prefill of the conversation
 * (measured: 187K tokens, ~127s, freezing the other slot at 0.9 t/s).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginContext } from "../context.js";
import type { MemoryIndex } from "../index-db.js";
import { onContext } from "../inject.js";
import type { Runtime } from "../runtime.js";
import { createRuntime } from "../runtime.js";

type SystemPart = { type: "text"; text: string };

let dataDir: string;
let dirA: string;
let dirB: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "memory-inject-data-"));
  // Both working directories are outside any repository, so `repoSnapshot`
  // is deterministic and carries the directory path.
  dirA = mkdtempSync(join(tmpdir(), "memory-inject-a-"));
  dirB = mkdtempSync(join(tmpdir(), "memory-inject-b-"));
  process.env.MEMORY_DATA_DIR = dataDir;
});

afterAll(() => {
  delete process.env.MEMORY_DATA_DIR;
  for (const dir of [dataDir, dirA, dirB]) rmSync(dir, { recursive: true, force: true });
});

/** Minimal plugin context: one mutable session and an empty history. */
function harness(directory: string) {
  let info = { projectID: "pTest", location: { directory } };
  const system: SystemPart[] = [];
  const ctx = {
    session: {
      get: async () => info,
      context: async () => [],
    },
  } as unknown as PluginContext;
  const runtime: Runtime = createRuntime(ctx, {} as MemoryIndex);
  const call = async (sessionID = "ses_a"): Promise<SystemPart[]> => {
    const event = { sessionID, system: [] as SystemPart[] };
    await onContext(ctx, runtime, event);
    return event.system;
  };
  return {
    call,
    moveTo: (next: string) => {
      info = { projectID: next === directory ? "pTest" : "pOther", location: { directory: next } };
    },
    runtime,
  };
}

describe("onContext", () => {
  test("pushes the block and the routing rule on every request", async () => {
    const { call } = harness(dirA);

    const first = await call();
    expect(first.length).toBe(2);
    expect(first[0]!.text).toContain("<memory-context>");
    expect(first[0]!.text).toContain(dirA);

    // The bug: this used to come back empty, dropping the head of the prompt.
    const second = await call();
    expect(second.length).toBe(2);
    expect(second).toEqual(first);

    const third = await call();
    expect(third).toEqual(first);
  });

  test("keeps the routing rule as its own trailing system part", async () => {
    const { call } = harness(dirA);
    const parts = await call();
    expect(parts.at(-1)?.text).toContain("Memory routing");
    expect(parts.at(-1)?.text).toContain("never overrides");
  });

  test("renders one block per session", async () => {
    const { call, runtime } = harness(dirA);
    await call("ses_a");
    await call("ses_b");
    expect(runtime.sessions.size).toBe(2);
    // Same project: both sessions get byte-identical blocks.
    const a = await call("ses_a");
    const b = await call("ses_b");
    expect(a).toEqual(b);
  });

  test("re-renders after the session moves to another project", async () => {
    const { call, moveTo } = harness(dirA);
    const before = await call();
    expect(before[0]!.text).toContain(dirA);

    moveTo(dirB);
    const after = await call();
    expect(after[0]!.text).toContain(dirB);
    expect(after[0]!.text).not.toBe(before[0]!.text);
  });
});
