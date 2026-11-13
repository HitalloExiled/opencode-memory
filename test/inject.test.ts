import { describe, expect, test } from "bun:test";

import { MEMORY_ROUTING_RULE } from "../inject.js";

describe("MEMORY_ROUTING_RULE", () => {
  test("is additive: it explicitly never overrides the original instructions", () => {
    expect(MEMORY_ROUTING_RULE).toContain("never overrides");
    expect(MEMORY_ROUTING_RULE).toContain("memory.search");
  });

  test("stays inside the memory layer: it never mentions notes", () => {
    expect(MEMORY_ROUTING_RULE.toLowerCase()).not.toContain("notes");
  });

  test("routes exact quotes through the tools and forbids the internal database", () => {
    expect(MEMORY_ROUTING_RULE).toContain('action="message"');
    expect(MEMORY_ROUTING_RULE).toContain("messageID");
    expect(MEMORY_ROUTING_RULE).toContain("internal database");
    expect(MEMORY_ROUTING_RULE).not.toContain("opencode.db");
  });

  test("never points at a context block or repository state", () => {
    expect(MEMORY_ROUTING_RULE).not.toContain("<memory-context>");
    expect(MEMORY_ROUTING_RULE).not.toContain("Repository state");
  });
});
