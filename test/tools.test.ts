/**
 * Contract tests for the tool surface itself: the schema the catalog publishes
 * (strict, short descriptions) and the dispatch rules that the individual
 * helpers do not own — required sessionID, pagination trailers and the
 * unknown-action answers.
 */

import { describe, expect, test } from "bun:test";

import type { PluginContext } from "../context.js";
import type { MemoryIndex } from "../index-db.js";
import type { Runtime } from "../runtime.js";
import { createRuntime } from "../runtime.js";
import { registerTools } from "../tools.js";
import type { MessageLike } from "../types.js";

interface RegisteredTool {
  name: string;
  description: string;
  input: { properties: Record<string, { description?: string }>; additionalProperties?: boolean };
  options?: { namespace?: string; pinned?: boolean };
  execute(input: unknown, context: { sessionID: string }): Promise<{ content: string }>;
}

const sessionInfo = {
  id: "ses_1",
  projectID: "p1",
  location: { directory: "/tmp/memory-tools-test" },
  time: { created: 1, updated: 2 },
};

const messages: MessageLike[] = [0, 1, 2].map((index) => ({
  type: "user",
  id: `m${index}`,
  text: `window ${index}`,
  time: { created: 1_700_000_000_000 + index * 1000 },
}));

/** The dispatch only reads these few methods; the rest would be dead weight. */
function fakeIndex(): MemoryIndex {
  return {
    backend: "json",
    upsert: async () => {},
    search: async () => [],
    summaryIDs: async () => [],
    getSession: () => undefined,
    setSession: () => {},
    count: async () => 0,
    remove: async () => {},
    clearProject: async () => {},
    clearAll: async () => {},
    flush: async () => {},
    close: async () => {},
    upsertVectors: async () => {},
    vectorState: async () => undefined,
    rehomeVectors: async () => {},
    loadVectors: async () => new Map(),
    vectorCount: async () => 0,
    deleteVectors: async () => {},
    pruneOldVectors: async () => 0,
    docs: async () => [],
    docsByIDs: async () => [],
    docsByIds: async () => [],
  } as unknown as MemoryIndex;
}

async function harness() {
  const added: RegisteredTool[] = [];
  const editor = {
    namespace: () => {},
    add: (tool: RegisteredTool) => added.push(tool),
    list: () => added,
    get: (name: string) => added.find((tool) => tool.name === name),
    update: () => {},
    remove: () => {},
  };
  const ctx = {
    tool: {
      transform: (apply: (editor: unknown) => void) => {
        apply(editor);
        return added;
      },
      reload: async () => {},
      list: async () => added,
    },
    session: {
      get: async () => sessionInfo,
      message: {
        list: async () => ({ data: messages, cursor: null }),
        get: async ({ messageID }: { messageID: string }) => messages.find((message) => message.id === messageID),
      },
      context: async () => messages,
    },
  } as unknown as PluginContext;
  const runtime: Runtime = createRuntime(ctx, fakeIndex());
  await registerTools(ctx, runtime);
  const call = (name: string, input: unknown) => {
    const tool = added.find((entry) => entry.name === name);
    if (!tool) throw new Error(`tool ${name} was not registered`);
    return tool.execute(input, { sessionID: "ses_1" });
  };
  return { added, call };
}

describe("tool schema", () => {
  test("registers the four tools, with only the read paths pinned", async () => {
    const { added } = await harness();
    expect(added.map((tool) => tool.name)).toEqual(["search", "summaries", "history", "index"]);
    for (const tool of added) {
      expect(tool.options?.namespace).toBe("memory");
      expect(tool.options?.pinned).toBe(tool.name !== "index");
    }
  });

  test("is strict about unknown parameters", async () => {
    const { added } = await harness();
    for (const tool of added) expect(tool.input.additionalProperties).toBe(false);
  });

  test("keeps every parameter description short enough for the catalog", async () => {
    const { added } = await harness();
    for (const tool of added) {
      for (const [name, property] of Object.entries(tool.input.properties)) {
        const description = property.description ?? "";
        expect(description.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(6);
        expect(description.length, `${tool.name}.${name}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("memory.history dispatch", () => {
  test("sessionID is required by read, search and message", async () => {
    const { call } = await harness();
    for (const action of ["read", "search", "message"]) {
      const { content } = await call("history", { action, query: "window", messageID: "m0" });
      expect(content).toContain("`sessionID`");
      expect(content).toContain("memory.search");
    }
  });

  test("sessions is the default action and needs no sessionID", async () => {
    const { call } = await harness();
    const { content } = await call("history", {});
    expect(content).toContain("Sessions (");
  });

  test("search pages with offset and says when more matches exist", async () => {
    const { call } = await harness();
    const first = await call("history", { action: "search", sessionID: "ses_1", query: "window", limit: 1 });
    expect(first.content).toContain("> More matches: call again with offset=1.");

    const last = await call("history", {
      action: "search",
      sessionID: "ses_1",
      query: "window",
      limit: 1,
      offset: 2,
    });
    expect(last.content).not.toContain("More matches");
  });

  test("rejects the removed content action", async () => {
    const { call } = await harness();
    const { content } = await call("history", { action: "content", sessionID: "ses_1", messageID: "m0" });
    expect(content).toContain('Unknown action "content"');
  });

  test("message without a window returns the whole formatted message", async () => {
    const { call } = await harness();
    const { content } = await call("history", { action: "message", sessionID: "ses_1", messageID: "m1" });
    expect(content).toContain("window 1");
    expect(content).not.toContain("charOffset");
  });

  test("message with charLimit slices the text and reports navigation", async () => {
    const { call } = await harness();
    const { content } = await call("history", {
      action: "message",
      sessionID: "ses_1",
      messageID: "m1",
      charOffset: 1,
      charLimit: 3,
    });
    expect(content).toContain("charOffset 1");
    expect(content).toContain("charLimit 3");
    expect(content).toContain("ind");
  });
});

describe("memory.index dispatch", () => {
  test("rejects an unknown action and lists the real ones", async () => {
    const { call } = await harness();
    const { content } = await call("index", { action: "nope" });
    expect(content).toContain('Unknown action "nope"');
    expect(content).toContain("doctor");
  });

  test("stats reports the backend and the project", async () => {
    const { call } = await harness();
    const { content } = await call("index", {});
    expect(content).toContain("backend: json");
    expect(content).toContain("project: p1");
  });

  test("doctor declares what it does not check", async () => {
    const { call } = await harness();
    const { content } = await call("index", { action: "doctor" });
    expect(content).toContain("Checkup");
    expect(content).toContain("Not checked:");
    expect(content).toContain("active context");
  });
});
