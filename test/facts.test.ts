import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FACT_CLIP,
  FACT_VALUE_MAX,
  factsLoad,
  factsInjection,
  factsSection,
  relevantFacts,
  removeFact,
  renderFactLine,
  resolveScope,
  setFact,
} from "../facts.js";
import { clearFacts } from "../facts-db.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "facts-test-"));
  process.env.MEMORY_DATA_DIR = dir;
});

afterAll(async () => {
  process.env.MEMORY_DATA_DIR = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** Fresh store: clear the facts table via the same connection. */
async function reset(): Promise<void> {
  await factsLoad();
  await clearFacts();
}

const MS = 1760000000000;

describe("store", () => {
  test("empty store degrades to empty doc", async () => {
    await reset();
    const doc = await factsLoad();
    expect(doc.facts).toEqual([]);
    expect(doc.nextId).toBe(1);
  });

  test("setFact appends with a new id and normalized value", async () => {
    await reset();
    const doc = await setFact("  User   prefers 4-space\nindentation ", { source: "ses_test" });
    expect(doc.facts).toHaveLength(1);
    expect(doc.facts[0]).toMatchObject({
      id: 1,
      scope: "machine",
      value: "User prefers 4-space indentation",
      source: "ses_test",
    });
    expect(doc.facts[0]!.updated).toBeGreaterThan(0);
    const reloaded = await factsLoad();
    expect(reloaded.facts).toHaveLength(1);
    expect(reloaded.nextId).toBe(2);
  });

  test("setFact with an id updates the fact in place", async () => {
    await reset();
    await setFact("old fact");
    const doc = await setFact("new fact", { id: 1, scope: "project:p", source: "ses_up" });
    expect(doc.facts).toHaveLength(1);
    expect(doc.facts[0]).toMatchObject({ id: 1, value: "new fact", scope: "project:p", source: "ses_up" });
  });

  test("setFact rejects empty values, oversized values, bad scopes and unknown ids", async () => {
    await reset();
    await setFact("seed");
    await expect(setFact("   ")).rejects.toThrow("empty");
    await expect(setFact("x".repeat(FACT_VALUE_MAX + 1))).rejects.toThrow("chars");
    await expect(setFact("x", { scope: "global" })).rejects.toThrow("scope");
    await expect(setFact("x", { scope: "project" })).rejects.toThrow("scope");
    await expect(setFact("x", { id: 99 })).rejects.toThrow("no fact");
    expect((await factsLoad()).facts).toHaveLength(1);
  });

  test("removeFact removes by id and ids are never reused", async () => {
    await reset();
    await setFact("a");
    await setFact("b");
    await removeFact(1);
    const doc = await factsLoad();
    expect(doc.facts.map((f: { id: number }) => f.id)).toEqual([2]);
    const next = await setFact("c");
    expect(next.facts.map((f: { id: number }) => f.id)).toEqual([2, 3]);
    await expect(removeFact(1)).rejects.toThrow("no fact");
  });

  test("concurrent setFact calls do not clobber each other", async () => {
    await reset();
    await Promise.all([
      setFact("concurrent 1", { source: "test" }),
      setFact("concurrent 2", { source: "test" }),
      setFact("concurrent 3", { source: "test" }),
      setFact("concurrent 4", { source: "test" }),
      setFact("concurrent 5", { source: "test" }),
    ]);
    const doc = await factsLoad();
    expect(doc.facts).toHaveLength(5);
    expect(doc.facts.map((f: { value: string }) => f.value)).toContain("concurrent 1");
    expect(doc.facts.map((f: { value: string }) => f.value)).toContain("concurrent 5");
  });
});

describe("relevance and injection", () => {
  async function seed(): Promise<void> {
    await reset();
    await setFact("user is rafael", { source: "t" });
    await new Promise((r) => setTimeout(r, 5));
    await setFact("working on the memory stack", { scope: "project:opencode-tools", source: "t" });
    await new Promise((r) => setTimeout(r, 5));
    await setFact("unrelated work", { scope: "project:other", source: "t" });
    await new Promise((r) => setTimeout(r, 5));
    await setFact("local model runs one inference at a time", { source: "t" });
  }

  test("relevantFacts: machine + matching project, newest first", async () => {
    await seed();
    const doc = await factsLoad();
    const facts = relevantFacts(doc, "/home/x/My/opencode-tools");
    expect(facts.map((f: { id: number }) => f.id)).toEqual([4, 2, 1]);
  });

  test("relevantFacts without a project directory: machine facts only", async () => {
    await seed();
    const doc = await factsLoad();
    expect(relevantFacts(doc).map((f: { id: number }) => f.id)).toEqual([4, 1]);
  });

  test("factsInjection applies the fact cap and reports omissions", async () => {
    delete process.env.MEMORY_PROFILE_INJECT;
    delete process.env.MEMORY_PROFILE_MAX;
    await seed();
    process.env.MEMORY_PROFILE_INJECT = "2";
    const doc = await factsLoad();
    const injection = factsInjection(doc, "/home/x/My/opencode-tools");
    expect(injection.facts.map((f: { id: number }) => f.id)).toEqual([4, 2]);
    expect(injection.omitted).toBe(1);
  });

  test("factsSection renders ids, scopes", async () => {
    delete process.env.MEMORY_PROFILE_INJECT;
    delete process.env.MEMORY_PROFILE_MAX;
    await seed();
    const doc = await factsLoad();
    const section = factsSection(factsInjection(doc, "/home/x/My/opencode-tools"));
    expect(section).toContain("#4 [machine]");
    expect(section).toContain("#2 [project:opencode-tools]");
    expect(section).not.toContain("project:other");
    const line = renderFactLine(doc.facts.find((f: { id: number }) => f.id === 4)!);
    expect(line).toContain("#4");
    expect(line).toContain("updated");
  });

  test("MEMORY_PROFILE_INJECT=0 disables the section", async () => {
    delete process.env.MEMORY_PROFILE_INJECT;
    delete process.env.MEMORY_PROFILE_MAX;
    await seed();
    process.env.MEMORY_PROFILE_INJECT = "0";
    const doc = await factsLoad();
    expect(factsSection(factsInjection(doc))).toBeUndefined();
  });
});

describe("scope resolution", () => {
  test("resolves machine, bare project and explicit project:<name>", () => {
    expect(resolveScope(undefined, "/home/x/My/opencode-tools")).toBe("machine");
    expect(resolveScope("machine", "/home/x/My/opencode-tools")).toBe("machine");
    expect(resolveScope("project", "/home/x/My/opencode-tools")).toBe("project:opencode-tools");
    expect(resolveScope("project", undefined)).toBe("machine");
    expect(resolveScope("project:other", "/home/x/My/opencode-tools")).toBe("project:other");
    expect(resolveScope("junk", "/home/x/My/opencode-tools")).toBe("machine");
  });
});
