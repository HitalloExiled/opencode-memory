import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { buildInjection, MEMORY_ROUTING_RULE } from "../inject.js";

beforeAll(() => {
  // Smallest allowed inject budget, to exercise the clip.
  process.env.MEMORY_INJECT_MAX = "1001";
});

afterAll(() => {
  delete process.env.MEMORY_INJECT_MAX;
});

describe("buildInjection", () => {
  test("carries only the repository state", () => {
    const out = buildInjection("repo: x (branch main)");
    expect(out).toContain("<memory-context>");
    expect(out).toContain("## Repository state");
    expect(out).toContain("repo: x (branch main)");
    expect(out).toContain("The current session is authoritative");
    expect(out).not.toContain("## Previous session handoff");
  });

  test("never injects a compaction handoff", () => {
    const out = buildInjection("repo: x");
    expect(out).not.toContain("Previous session handoff");
    expect(out).not.toContain("untrusted data");
    expect(out).not.toContain("### Objective");
    expect(out).not.toContain("### Next Move");
  });

  test("carries no notes data: notes have their own layer and block", () => {
    const out = buildInjection("repo: x");
    expect(out).not.toContain("<notes-context>");
    expect(out).not.toContain("Pinned notes");
    expect(out).not.toContain("notes.search");
  });

  test("clips to the configured maximum", () => {
    const out = buildInjection("r".repeat(3000));
    expect(out.length).toBeLessThanOrEqual(1001);
    expect(out).toContain("truncated");
  });
});

describe("MEMORY_ROUTING_RULE", () => {
  test("is additive: it explicitly never overrides the original instructions", () => {
    expect(MEMORY_ROUTING_RULE).toContain("never overrides");
    expect(MEMORY_ROUTING_RULE).toContain("memory.search");
  });

  test("stays inside the memory layer: it never mentions notes", () => {
    expect(MEMORY_ROUTING_RULE.toLowerCase()).not.toContain("notes");
  });
});
