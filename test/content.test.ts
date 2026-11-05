import { describe, expect, test } from "bun:test";

import { contentWindow, messageToView } from "../history.js";
import type { MessageLike } from "../types.js";

describe("contentWindow", () => {
  test("centers the window on the first occurrence", () => {
    const text = `${"a".repeat(1000)}needle${"b".repeat(1000)}`;
    const win = contentWindow(text, ["needle"], 200);
    expect(win.total).toBe(2006);
    expect(win.offset).toBe(900);
    expect(win.start).toBe(900);
    expect(win.end).toBe(1100);
    expect(win.length).toBe(200);
    expect(win.text).toContain("needle");
  });

  test("honors an explicit offset and clamps it to the end", () => {
    const win = contentWindow("abcdefghij", ["x"], 4, 6);
    expect(win).toMatchObject({ offset: 6, start: 6, end: 10, length: 4, text: "ghij" });

    const past = contentWindow("abcdef", [], 4, 999);
    expect(past).toMatchObject({ offset: 2, start: 2, end: 6, length: 4, text: "cdef" });
  });

  test("starts at 0 when there is no occurrence", () => {
    const win = contentWindow("hello world", ["missing"], 5);
    expect(win).toMatchObject({ offset: 0, start: 0, end: 5, text: "hello", total: 11 });
  });

  test("returns the whole text when it is shorter than the limit", () => {
    const win = contentWindow("hi", [], 100);
    expect(win).toMatchObject({ offset: 0, start: 0, end: 2, length: 2, text: "hi", total: 2 });
  });

  test("picks the earliest of several terms", () => {
    const win = contentWindow("xxxx beta yyyy alpha", ["alpha", "beta"], 10);
    expect(win.offset).toBe(0);
    expect(win.text).toBe("xxxx beta ");
  });

  test("caps the limit at 8000 characters", () => {
    const text = "x".repeat(9000);
    const win = contentWindow(text, [], 50_000);
    expect(win.length).toBe(8000);
    expect(win.total).toBe(9000);
  });
});

describe("messageToView", () => {
  test("hides tools and reasoning by default and reports their presence", () => {
    const message: MessageLike = {
      id: "a1",
      type: "assistant",
      time: { created: 2000 },
      agent: "build",
      model: { providerID: "openai", id: "gpt-5" },
      content: [
        { type: "text", text: "answer" },
        { type: "reasoning", text: "secret" },
        { type: "tool", name: "shell", state: { status: "completed" } },
      ],
    };
    const view = messageToView(message);
    expect(view?.text).toBe("answer");
    expect(view?.text).not.toContain("secret");
    expect(view?.hasTools).toBe(true);
    expect(view?.agent).toBe("build");
    expect(view?.model).toBe("openai/gpt-5");
    expect(view?.kind).toBe("assistant");
  });

  test("includes attachment names and skips empty narratives", () => {
    const user: MessageLike = {
      id: "u1",
      type: "user",
      text: "look",
      files: [{ name: "a.ts" }, { description: "b.ts" }],
    };
    const view = messageToView(user);
    expect(view?.files).toEqual(["a.ts", "b.ts"]);
    expect(view?.kind).toBe("user");

    expect(messageToView({ id: "a2", type: "assistant", content: [] })).toBeUndefined();
  });

  test("maps completed compactions to summaries", () => {
    const view = messageToView({
      id: "c1",
      type: "compaction",
      status: "completed",
      summary: "## Objective\n- x",
      time: { created: 3000 },
    });
    expect(view?.kind).toBe("summary");
    expect(view?.text).toContain("Objective");
  });
});
