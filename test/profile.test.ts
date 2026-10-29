import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FACT_CLIP,
  FACT_VALUE_MAX,
  loadProfile,
  profileInjection,
  profileSection,
  relevantFacts,
  removeFact,
  renderFactLine,
  resolveScope,
  setFact,
} from "../profile.js";

let dir: string;
let profileFile: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "profile-test-"));
  profileFile = join(dir, "profile.json");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Fresh store between tests. */
async function reset(): Promise<void> {
  await rm(profileFile, { force: true }).catch(() => undefined);
}

const MS = 1760000000000;

describe("store", () => {
  test("missing file degrades to the empty doc", async () => {
    await reset();
    const doc = await loadProfile(profileFile);
    expect(doc.facts).toEqual([]);
    expect(doc.nextId).toBe(1);
  });

  test("malformed file degrades to the empty doc (bad json / bad entries)", async () => {
    await reset();
    const { atomicWrite } = await import("../storage.js");
    await atomicWrite(profileFile, "{ not json");
    expect((await loadProfile(profileFile)).facts).toEqual([]);
    await atomicWrite(profileFile, '{"version":1,"nextId":1,"facts":[{"id":"x","value":"no id"},{"id":1},{"value":"no id"},null,"junk"]}');
    const doc = await loadProfile(profileFile);
    expect(doc.facts).toEqual([]);
  });

  test("setFact appends with a new id and normalized value", async () => {
    await reset();
    const doc = await setFact("  User   prefers 4-space\nindentation ", { source: "ses_test", path: profileFile });
    expect(doc.facts).toHaveLength(1);
    expect(doc.facts[0]).toMatchObject({
      id: 1,
      scope: "machine",
      value: "User prefers 4-space\nindentation",
      source: "ses_test",
    });
    const reloaded = await loadProfile(profileFile);
    expect(reloaded.facts).toHaveLength(1);
    expect(reloaded.nextId).toBe(2);
  });

  test("setFact with an id updates the fact in place (id and value kept stable)", async () => {
    await reset();
    await setFact("old fact", { path: profileFile });
    const doc = await setFact("new fact", { id: 1, scope: "project:p", source: "ses_up", path: profileFile });
    expect(doc.facts).toHaveLength(1);
    expect(doc.facts[0]).toMatchObject({ id: 1, value: "new fact", scope: "project:p", source: "ses_up" });
  });

  test("setFact rejects empty values, oversized values, bad scopes and unknown ids", async () => {
    await reset();
    await setFact("seed", { path: profileFile });
    await expect(setFact("   ", { path: profileFile })).rejects.toThrow("empty");
    await expect(setFact("x".repeat(FACT_VALUE_MAX + 1), { path: profileFile })).rejects.toThrow("chars");
    await expect(setFact("x", { scope: "global", path: profileFile })).rejects.toThrow("scope");
    await expect(setFact("x", { scope: "project", path: profileFile })).rejects.toThrow("scope");
    await expect(setFact("x", { id: 99, path: profileFile })).rejects.toThrow("no fact");
    expect((await loadProfile(profileFile)).facts).toHaveLength(1);
  });

  test("removeFact removes by id and ids are never reused", async () => {
    await reset();
    await setFact("a", { path: profileFile });
    await setFact("b", { path: profileFile });
    await removeFact(1, { path: profileFile });
    const doc = await loadProfile(profileFile);
    expect(doc.facts.map((f) => f.id)).toEqual([2]);
    const next = await setFact("c", { path: profileFile });
    expect(next.facts.map((f) => f.id)).toEqual([2, 3]);
    await expect(removeFact(1, { path: profileFile })).rejects.toThrow("no fact");
  });
});

describe("relevance and injection", () => {
  async function seed(): Promise<void> {
    await reset();
    const { saveProfile } = await import("../profile.js");
    await saveProfile(
      {
        version: 1,
        nextId: 5,
        facts: [
          { id: 1, scope: "machine", value: "user is rafael", updated: MS + 1_000, source: "t" },
          { id: 2, scope: "project:opencode-tools", value: "working on the memory stack", updated: MS + 2_000, source: "t" },
          { id: 3, scope: "project:other", value: "unrelated work", updated: MS + 3_000, source: "t" },
          { id: 4, scope: "machine", value: "local model runs one inference at a time", updated: MS + 4_000, source: "t" },
        ],
      },
      profileFile,
    );
  }

  test("relevantFacts: machine + matching project, newest first", async () => {
    await seed();
    const doc = await loadProfile(profileFile);
    const facts = relevantFacts(doc, "/home/x/My/opencode-tools");
    expect(facts.map((f) => f.id)).toEqual([4, 2, 1]);
  });

  test("relevantFacts without a project directory: machine facts only", async () => {
    await seed();
    const doc = await loadProfile(profileFile);
    expect(relevantFacts(doc, undefined).map((f) => f.id)).toEqual([4, 1]);
  });

  test("profileInjection applies the fact cap and reports omissions", async () => {
    delete process.env.MEMORY_PROFILE_INJECT;
    delete process.env.MEMORY_PROFILE_MAX;
    await seed();
    process.env.MEMORY_PROFILE_INJECT = "2";
    const doc = await loadProfile(profileFile);
    const injection = profileInjection(doc, "/home/x/My/opencode-tools");
    expect(injection.facts.map((f) => f.id)).toEqual([4, 2]);
    expect(injection.omitted).toBe(1);
  });

  test("profileInjection stops at the char budget and never half-renders a fact", async () => {
    delete process.env.MEMORY_PROFILE_INJECT;
    delete process.env.MEMORY_PROFILE_MAX;
    await reset();
    const { saveProfile } = await import("../profile.js");
    await saveProfile(
      {
        version: 1,
        nextId: 3,
        facts: [
          { id: 1, scope: "machine", value: "a".repeat(FACT_CLIP), updated: MS + 1, source: "t" },
          { id: 2, scope: "machine", value: "b".repeat(FACT_CLIP), updated: MS + 2, source: "t" },
        ],
      },
      profileFile,
    );
    process.env.MEMORY_PROFILE_MAX = String(FACT_CLIP + 100); // room for exactly one fact line
    const doc = await loadProfile(profileFile);
    const injection = profileInjection(doc, undefined);
    expect(injection.facts.map((f) => f.id)).toEqual([2]);
    expect(injection.omitted).toBe(1);
    expect(profileSection(injection)).toContain("1 more fact(s) not shown");
  });

  test("MEMORY_PROFILE_INJECT=0 disables the section", async () => {
    delete process.env.MEMORY_PROFILE_INJECT;
    delete process.env.MEMORY_PROFILE_MAX;
    await seed();
    process.env.MEMORY_PROFILE_INJECT = "0";
    const doc = await loadProfile(profileFile);
    expect(profileSection(profileInjection(doc, undefined))).toBeUndefined();
  });

  test("profileSection renders ids, scopes and a pointer to the tool", async () => {
    delete process.env.MEMORY_PROFILE_INJECT;
    delete process.env.MEMORY_PROFILE_MAX;
    await seed();
    const doc = await loadProfile(profileFile);
    const section = profileSection(profileInjection(doc, "/home/x/My/opencode-tools"));
    expect(section).toContain("#4 [machine]");
    expect(section).toContain("#2 [project:opencode-tools]");
    expect(section).not.toContain("project:other");
    // No omissions here: all relevant facts fit the quota, so no pointer line.
    expect(section).not.toContain("memory.profile get");
    const line = renderFactLine(doc.facts.find((fact) => fact.id === 4)!);
    expect(line).toContain("#4");
    expect(line).toContain("updated");
  });
});

describe("scope resolution", () => {
  test("resolves machine, bare project (current project) and explicit project:<name>", () => {
    expect(resolveScope(undefined, "/home/x/My/opencode-tools")).toBe("machine");
    expect(resolveScope("machine", "/home/x/My/opencode-tools")).toBe("machine");
    expect(resolveScope("project", "/home/x/My/opencode-tools")).toBe("project:opencode-tools");
    expect(resolveScope("project", undefined)).toBe("machine");
    expect(resolveScope("project:other", "/home/x/My/opencode-tools")).toBe("project:other");
    expect(resolveScope("junk", "/home/x/My/opencode-tools")).toBe("machine");
  });
});
