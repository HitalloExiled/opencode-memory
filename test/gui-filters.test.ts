import { describe, expect, test } from "bun:test";

import type { HitView } from "../src/gui/contract.js";
import {
  buildQuote,
  groupHitsBySession,
  highlightParts,
  mergeHits,
  termsOf,
} from "../src/gui/filters.js";

const quoteLabels = (key: string, ...args: unknown[]): string => {
  const table: Record<string, string> = {
    "quote.tag": "memória",
    "quote.session": "sessão",
    "quote.message": "mensagem",
    "quote.occurrence": 'ocorrência de "{0}"',
    "quote.selected": "(trecho selecionado)",
    "quote.range": "Trecho: {0} (offset {1}, tamanho {2}; truncado em {3}).",
    "quote.chars": "chars {0}–{1} de {2}",
    "quote.around": "Para consultar em torno da ocorrência:",
    "quote.unknownDate": "data desconhecida",
  };
  return (table[key] ?? key).replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)] ?? ""));
};

const hit = (overrides: Partial<HitView> & Pick<HitView, "id" | "sessionID">): HitView => ({
  projectID: "p1",
  kind: "user",
  created: 1000,
  snippet: "snippet",
  ...overrides,
});

describe("groupHitsBySession", () => {
  test("groups in first-appearance order and caps snippets", () => {
    const groups = groupHitsBySession(
      [
        hit({ id: "1", sessionID: "s1", title: "one", created: 10 }),
        hit({ id: "2", sessionID: "s2", title: "two", created: 20 }),
        hit({ id: "3", sessionID: "s1", title: "one", created: 30 }),
        hit({ id: "4", sessionID: "s1", title: "one", created: 40 }),
        hit({ id: "5", sessionID: "s1", title: "one", created: 50 }),
      ],
      2,
    );
    expect(groups.map((group) => group.sessionID)).toEqual(["s1", "s2"]);
    expect(groups[0]?.total).toBe(4);
    expect(groups[0]?.hits.map((entry) => entry.id)).toEqual(["1", "3"]);
    expect(groups[0]?.updated).toBe(50);
    expect(groups[1]?.total).toBe(1);
  });
});

describe("mergeHits", () => {
  test("appends only unseen ids", () => {
    const merged = mergeHits(
      [hit({ id: "1", sessionID: "s1" })],
      [hit({ id: "1", sessionID: "s1" }), hit({ id: "2", sessionID: "s1" })],
    );
    expect(merged.map((entry) => entry.id)).toEqual(["1", "2"]);
  });
});

describe("termsOf / highlightParts", () => {
  test("tokenizes and de-duplicates query terms", () => {
    expect(termsOf("Busca busca, MEMÓRIA! x")).toEqual(["busca", "memória"]);
  });

  test("marks every occurrence, including at the start", () => {
    const parts = highlightParts("alpha beta alpha", ["alpha"]);
    expect(parts).toEqual([
      { text: "alpha", match: true },
      { text: " beta ", match: false },
      { text: "alpha", match: true },
    ]);
  });

  test("returns the whole text when there are no terms", () => {
    expect(highlightParts("plain", [])).toEqual([{ text: "plain", match: false }]);
  });
});

describe("buildQuote", () => {
  test("reports the total size, offset and the tool hint", () => {
    const text = buildQuote({
      sessionID: "ses_1",
      messageID: "msg_1",
      title: "A conversation",
      kind: "assistant",
      created: Date.UTC(2026, 0, 2, 3, 4),
      text: "the slice",
      total: 9000,
      offset: 4000,
      length: 2000,
      start: 4000,
      end: 6000,
      limit: 2000,
      query: "needle",
    }, quoteLabels);
    expect(text).toContain("[memória] A conversation · sessão ses_1 · mensagem msg_1 · assistant");
    expect(text).toContain("2026-01-02 03:04Z");
    expect(text).toContain('ocorrência de "needle"');
    expect(text).toContain("chars 4000–6000 de 9000");
    expect(text).toContain("offset 4000, tamanho 2000; truncado em 2000");
    expect(text).toContain('memory.history action="content" sessionID="ses_1" messageID="msg_1" offset=4000 limit=2000 scope="all"');
    expect(text.endsWith("\n\nthe slice")).toBe(true);
  });
});
