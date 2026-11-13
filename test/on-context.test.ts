/**
 * Regression: the routing rule must be present on EVERY agent-loop request,
 * with identical bytes.
 *
 * The server rebuilds `system` from scratch for each request, so a part that is
 * pushed only on the first one disappears on the next turn and shortens the
 * head of the prompt, which drops the slot's LCP similarity and forces a full
 * re-prefill of the conversation. A constant string per request keeps the head
 * byte-identical.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginContext } from "../context.js";
import type { MemoryIndex } from "../index-db.js";
import { MEMORY_ROUTING_RULE, onContext } from "../inject.js";
import type { Runtime } from "../runtime.js";
import { createRuntime } from "../runtime.js";

type SystemPart = { type: "text"; text: string };

let dataDir: string;
let dirA: string;
let dirB: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "memory-inject-data-"));
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
  test("pushes the routing rule on every request, byte-identical", async () => {
    const { call } = harness(dirA);

    const first = await call();
    expect(first.length).toBe(1);
    expect(first[0]!.text).toBe(MEMORY_ROUTING_RULE);

    // The bug: this used to come back empty, dropping the head of the prompt.
    const second = await call();
    expect(second).toEqual(first);

    const third = await call();
    expect(third).toEqual(first);
  });

  test("injects no context block: memory carries no live state", async () => {
    const { call } = harness(dirA);
    const text = (await call())[0]!.text;
    expect(text).not.toContain("<memory-context>");
    expect(text).not.toContain("Repository state");
    expect(text).not.toContain(dirA);
  });

  test("tracks one project per session without changing the prompt", async () => {
    const { call, runtime } = harness(dirA);
    await call("ses_a");
    await call("ses_b");
    expect(runtime.sessions.size).toBe(2);
    expect((await call("ses_a"))[0]!.text).toBe((await call("ses_b"))[0]!.text);
  });

  test("re-resolves the project after the session moves to another directory", async () => {
    const { call, moveTo, runtime } = harness(dirA);
    await call();
    expect(runtime.sessions.get("ses_a")?.projectID).toBe("pTest");

    moveTo(dirB);
    await call();
    expect(runtime.sessions.get("ses_a")?.projectID).toBe("pOther");
    // Same bytes: the prompt does not carry the directory anymore.
    expect((await call())[0]!.text).toBe(MEMORY_ROUTING_RULE);
  });
});
