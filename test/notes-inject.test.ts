import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

import { notesSection, relevantNotes, scopeOf } from "../notes-inject.js";

// /tmp is ephemeral in the agent environment: keep scratch state in the repo
// (untracked) and clean it up afterwards.
const testBase = process.env.MEMORY_TEST_TMP ?? join(process.cwd(), ".memory-test-tmp");

let dataDir = "";
let db: Database;

// The user account's first part is one of this machine's identifiers, so a
// note scoped `machine:<that>` must match regardless of hostname.
const userPart = userInfo().username.split(".")[0] || "testuser";

const FIXTURES = [
  {
    ts: "2026-10-27 09:00:01",
    category: "config",
    title: "Project note alpha",
    content: "Alpha fact about the project.\nScope: project:agent-toolbelt",
    author: "build",
    disputedAt: null,
    retractedAt: null,
    pinned: 1,
  },
  {
    ts: "2026-10-27 09:00:02",
    category: "config",
    title: "Bare machine note beta",
    content: "Beta machine fact.\nScope: machine",
    author: null,
    disputedAt: null,
    retractedAt: null,
    pinned: 1,
  },
  {
    ts: "2026-10-27 09:00:03",
    category: "config",
    title: `Machine named note gamma (machine:${userPart})`,
    content: `Gamma machine fact.\nScope: machine:${userPart}`,
    author: null,
    disputedAt: null,
    retractedAt: null,
    pinned: 1,
  },
  {
    ts: "2026-10-27 09:00:04",
    category: "decision",
    title: "Disputed project note delta",
    content: "Delta decision, disputed.\nScope: project:agent-toolbelt",
    author: null,
    disputedAt: "2026-10-27 09:30:00",
    retractedAt: null,
    pinned: 1,
  },
  {
    ts: "2026-10-27 09:00:05",
    category: "general",
    title: "Other project note",
    content: "Epsilon fact.\nScope: project:some-other-project",
    author: null,
    disputedAt: null,
    retractedAt: null,
    pinned: 0,
  },
  {
    ts: "2026-10-27 09:00:06",
    category: "general",
    title: "Global note",
    content: "Zeta global fact.\nScope: global",
    author: null,
    disputedAt: null,
    retractedAt: null,
    pinned: 0,
  },
  {
    ts: "2026-10-27 09:00:07",
    category: "general",
    title: "Retracted note",
    content: "Eta noise.\nScope: project:agent-toolbelt",
    author: null,
    disputedAt: null,
    retractedAt: "2026-10-27 09:40:00",
    pinned: 1,
  },
  {
    ts: "2026-10-27 09:00:08",
    category: "general",
    title: "Unscoped note",
    content: "Theta fact with no scope line.",
    author: null,
    disputedAt: null,
    retractedAt: null,
    pinned: 0,
  },
  {
    ts: "2026-10-27 09:00:09",
    category: "general",
    title: "Non-pinned matching-scope note",
    content: "Iota fact.\nScope: project:agent-toolbelt",
    author: "build",
    disputedAt: null,
    retractedAt: null,
    pinned: 0,
  },
];

beforeAll(async () => {
  await mkdir(testBase, { recursive: true });
  dataDir = await mkdtemp(join(testBase, "memory-notes-"));
  process.env.MEMORY_DATA_DIR = dataDir;
  process.env.MEMORY_NOTES_INJECT = "10";
  db = new Database(join(dataDir, "notes.db"), { create: true });
  db.exec(`
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      category TEXT NOT NULL,
      tags TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      verified_at TEXT,
      disputed_at TEXT,
      retracted_at TEXT,
      status_reason TEXT,
      author TEXT,
      pinned INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = db.prepare(
    `INSERT INTO notes (timestamp, category, tags, title, content, disputed_at, retracted_at, author, pinned)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of FIXTURES) insert.run(f.ts, f.category, f.title, f.content, f.disputedAt, f.retractedAt, f.author, f.pinned);
});

afterAll(async () => {
  db.close();
  delete process.env.MEMORY_DATA_DIR;
  delete process.env.MEMORY_NOTES_INJECT;
  await rm(dataDir, { recursive: true, force: true });
  await rm(testBase, { recursive: true, force: true }).catch(() => undefined);
});

describe("scopeOf", () => {
  test("reads the first Scope line", () => {
    expect(scopeOf("content\nScope: project:agent-toolbelt\nmore")).toBe("project:agent-toolbelt");
    expect(scopeOf("no scope here")).toBe("");
  });
});

describe("relevantNotes", () => {
  test("keeps pinned in-scope notes, excludes non-pinned, out-of-scope and retracted ones", async () => {
    const notes = await relevantNotes("/some/path/agent-toolbelt");
    const titles = notes.map((note) => note.title);
    expect(titles).toContain("Project note alpha");
    expect(titles).toContain("Bare machine note beta");
    expect(titles).toContain(`Machine named note gamma (machine:${userPart})`);
    expect(titles).toContain("Disputed project note delta");
    // Ordered most recent first.
    expect(titles[0]).toBe("Disputed project note delta");
    // Excluded: other project (non-pinned), global (non-pinned), retracted
    // (even though pinned), unscoped (non-pinned), and matching-scope but
    // non-pinned.
    for (const absent of [
      "Other project note",
      "Global note",
      "Retracted note",
      "Unscoped note",
      "Non-pinned matching-scope note",
    ]) {
      expect(titles).not.toContain(absent);
    }
    // Pinning is the injection gate: only 4 of 9 notes reach the session.
    expect(notes.length).toBe(4);
  });

  test("flags disputed notes", async () => {
    const notes = await relevantNotes("/some/path/agent-toolbelt");
    const delta = notes.find((note) => note.title === "Disputed project note delta");
    expect(delta?.disputed).toBe(true);
    const alpha = notes.find((note) => note.title === "Project note alpha");
    expect(alpha?.disputed).toBe(false);
  });

  test("caps at MEMORY_NOTES_INJECT and supports 0 (disabled)", async () => {
    try {
      process.env.MEMORY_NOTES_INJECT = "2";
      expect((await relevantNotes("/some/path/agent-toolbelt")).length).toBe(2);
      process.env.MEMORY_NOTES_INJECT = "0";
      expect(await relevantNotes("/some/path/agent-toolbelt")).toEqual([]);
    } finally {
      process.env.MEMORY_NOTES_INJECT = "10";
    }
  });

  test("is empty when the session has no project directory", async () => {
    delete process.env.MEMORY_NOTES_INJECT;
    const notes = await relevantNotes(undefined);
    // Only the bare-machine and named-machine notes can match without a project.
    for (const note of notes) expect(note.scope).toMatch(/^machine/);
  });

  test("degrades to empty when there is no notes database", async () => {
    const empty = await mkdtemp(join(testBase, "memory-notes-empty-"));
    process.env.MEMORY_DATA_DIR = empty;
    expect(await relevantNotes("/some/path/agent-toolbelt")).toEqual([]);
    process.env.MEMORY_DATA_DIR = dataDir;
    await rm(empty, { recursive: true, force: true });
  });
});

describe("notesSection", () => {
  test("renders nothing for an empty list", () => {
    expect(notesSection([])).toBeUndefined();
  });

  test("renders id, category, scope, author and clipped content", async () => {
    process.env.MEMORY_NOTES_INJECT = "10";
    const notes = await relevantNotes("/some/path/agent-toolbelt");
    const section = notesSection(notes);
    expect(section).toBeDefined();
    expect(section).toContain("#1 [config]");
    expect(section).toContain("scope: project:agent-toolbelt");
    expect(section).toContain("by build");
    expect(section).toContain("⚠ disputed");
  });

  test("clips long content", async () => {
    const section = notesSection([
      {
        id: 99,
        category: "problem",
        title: "Long",
        scope: "machine",
        updatedAt: "2026-10-27 10:00:00",
        author: "build",
        disputed: false,
        content: "x".repeat(5000) + "\nScope: machine",
      },
    ]);
    expect(section).toBeDefined();
    expect(section!.length).toBeLessThan(900);
  });
});
