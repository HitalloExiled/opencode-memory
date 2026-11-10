/**
 * Memory side panel — SolidJS UI.
 *
 * Search runs over the server plugin's RPC (hybrid index); results are
 * grouped by session and a click opens the full conversation, paged by
 * cursor as the user scrolls. "Adicionar ao contexto" quotes a bounded slice
 * of a message into the routed session's composer, with the total size and
 * the offset the agent needs to read around it.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { usePanel, usePlugin, type MountedSession, type Persisted } from "@opencode/plugin/gui";
import { SHARED_CSS, ScrollNav, createScrollNav, EmptyState, EndMarker, ErrorBanner, LoadingRow, StatusChip, type ChipTone } from "opencode-shared/gui";
import type { ViewEntry, ViewState } from "./state";
import {
  MemoryRpc,
  QUOTE_CHARS_DEFAULT,
  QUOTE_CHARS_OPTIONS,
  type HitView,
  type MessageView,
  type SessionView,
  type Status,
} from "./contract";
import { buildQuote, groupHitsBySession, highlightParts, termsOf } from "./filters";
import { useT } from "./i18n";

const CSS = `
.mem {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  height: 100%;
  min-height: 0;
  padding: 12px;
  color: var(--v2-text-text-base);
  font-family: var(--font-family-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 12.5px;
}
.mem::selection,
.mem ::selection {
  background-color: var(--timeline-quote-background, light-dark(rgb(from var(--v2-blue-1100) r g b / 0.1), rgb(from var(--v2-blue-400) r g b / 0.25)));
  color: currentColor;
}
.mem-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.mem-title { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; }
.mem-title-text { margin: 0; font-size: 13px; font-weight: 600; }
.mem-sub { color: var(--v2-text-text-muted); font-size: 11px; margin-top: 1px; }
.mem-actions { display: flex; align-items: center; gap: 4px; }
.mem-controls { display: flex; flex-direction: column; gap: 6px; }
.mem-search { position: relative; display: flex; }
.mem-search > [data-component="text-input-v2"] { width: 100%; }
.mem-search [data-slot="text-input-v2-input"] { padding-inline-end: 30px; }
.mem-search-clear { position: absolute; right: 5px; top: 50%; transform: translateY(-50%); }
.mem-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  border: 0;
  background: transparent;
  color: var(--v2-text-text-muted);
  padding: 4px 9px;
  border-radius: 6px;
  font-size: 11.5px;
  cursor: pointer;
}
.mem-select {
  margin-left: auto;
  border: 1px solid var(--v2-border-border-muted);
  background: var(--v2-background-bg-layer-02);
  color: var(--v2-text-text-base);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 11px;
}
.mem-status { color: var(--v2-text-text-muted); font-size: 10.5px; line-height: 1.4; }
  padding: 8px 10px;
  border-radius: 6px;
  color: var(--v2-state-fg-danger, #e03131);
  background: var(--v2-state-bg-danger, rgba(224,49,49,.08));
  border: 1px solid var(--v2-state-border-danger, rgba(224,49,49,.25));
  white-space: pre-wrap;
}
.mem-note { color: var(--v2-text-text-muted); font-size: 10.5px; line-height: 1.45; }
.mem-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; padding-bottom: 36px; }
.mem-section-title { font-weight: 600; font-size: 12px; color: var(--v2-text-text-base); margin-top: 2px; }
.mem-session {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid var(--v2-border-border-muted);
  background: var(--v2-background-bg-layer-02);
  color: var(--v2-text-text-base);
  cursor: pointer;
}
.mem-session:hover { background: var(--v2-overlay-simple-overlay-hover); border-color: var(--v2-border-border-strong); }
.mem-session:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: 0; }
.mem-session-title { font-weight: 600; font-size: 12.5px; line-height: 1.3; overflow-wrap: anywhere; }
.mem-session-meta { color: var(--v2-text-text-muted); font-size: 10.5px; overflow-wrap: anywhere; }
.mem-session-dir { color: var(--v2-text-text-faint); font-size: 10px; overflow-wrap: anywhere; }
.mem-group {
  display: flex;
  flex-direction: column;
  gap: 0;
  border-radius: 8px;
  border: 1px solid var(--v2-border-border-muted);
  background: var(--v2-background-bg-layer-02);
  overflow: hidden;
}
.mem-group-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--v2-border-border-muted);
  background: var(--v2-background-bg-layer-01);
}
.mem-group-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mem-group-title { font-weight: 600; font-size: 12.5px; line-height: 1.3; overflow-wrap: anywhere; }
.mem-group-meta { color: var(--v2-text-text-muted); font-size: 10.5px; overflow-wrap: anywhere; }
.mem-hit { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-bottom: 1px solid var(--v2-border-border-muted); }
.mem-hit:last-child { border-bottom: 0; }
.mem-hit-meta { color: var(--v2-text-text-muted); font-size: 10px; }
.mem-hit-text { font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; white-space: pre-wrap; user-select: text; cursor: text; }
.mem-hit-text mark { background: var(--v2-state-bg-warning, rgba(255, 212, 59, .35)); color: inherit; border-radius: 2px; padding: 0 1px; }
.mem-hit-actions { display: flex; justify-content: flex-end; }
.mem-more { padding: 6px 10px; color: var(--v2-text-text-muted); font-size: 10.5px; }
.mem-conversation-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  padding-bottom: 2px;
}
.mem-back {
  align-self: flex-start;
  border: 0;
  background: transparent;
  color: var(--v2-text-text-muted);
  cursor: pointer;
  padding: 2px 0;
  font-size: 11.5px;
}
.mem-back:hover { color: var(--v2-text-text-base); }
.mem-timeline-head { display: flex; flex-direction: column; gap: 2px; padding-bottom: 4px; }
.mem-timeline-head-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.mem-timeline-title { font-weight: 600; font-size: 13px; line-height: 1.3; overflow-wrap: anywhere; }
.mem-timeline-meta { color: var(--v2-text-text-muted); font-size: 10.5px; overflow-wrap: anywhere; }
.mem-msg {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid var(--v2-border-border-muted);
  background: var(--v2-background-bg-layer-02);
}
.mem-msg-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  background: var(--v2-overlay-simple-overlay-hover);
  color: var(--v2-text-text-muted);
}
.mem-msg-meta { color: var(--v2-text-text-muted); font-size: 10px; }
.mem-badge { color: var(--v2-text-text-faint); font-size: 9.5px; border: 1px solid var(--v2-border-border-muted); border-radius: 999px; padding: 0 5px; }
.mem-msg-text { font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; user-select: text; cursor: text; }
.mem-msg-actions { display: flex; justify-content: flex-end; }
.mem-sentinel { height: 1px; flex: 0 0 auto; }
.mem-body { position: relative; display: flex; flex: 1; min-height: 0; }
  position: absolute;
  left: 50%;
  z-index: 10;
  transform: translateX(-50%);
}
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--v2-border-border-muted);
  background-color: var(--v2-background-bg-layer-01);
  box-shadow: var(--v2-elevation-raised, 0 4px 16px rgba(0, 0, 0, .2));
}
.mem-quote-toolbar {
  position: fixed;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid var(--v2-border-border-muted);
  background: var(--v2-background-bg-layer-01);
  box-shadow: var(--v2-elevation-raised, 0 4px 16px rgba(0, 0, 0, .2));
}
`;

type RpcSession = NonNullable<ReturnType<ReturnType<typeof usePlugin>["sessions"]["current"]>>;

const LIST_PAGE_SIZE = 20;

export function MemoryView(props: { session: MountedSession; store: Persisted<ViewState> }) {
  const ctx = usePlugin();
  const panel = usePanel();
  const t = useT();

  const [query, setQuery] = createSignal("");
  const [projectOnly, setProjectOnly] = createSignal(true);
  const [quoteChars, setQuoteChars] = createSignal<number>(QUOTE_CHARS_DEFAULT);
  const [status, setStatus] = createSignal<Status | null>(null);
  const [projects, setProjects] = createSignal<Array<{ id: string; canonical: string; name?: string }>>([]);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [hydratedSession, setHydratedSession] = createSignal("");
  const [listPage, setListPage] = createSignal(0);

  // Search results (query non-empty).
  const [hits, setHits] = createSignal<HitView[]>([]);
  const [hitsHasMore, setHitsHasMore] = createSignal(false);
  const [searchPartial, setSearchPartial] = createSignal(false);
  const [vectorNote, setVectorNote] = createSignal("");

  // Recent sessions (query empty).
  const [sessions, setSessions] = createSignal<SessionView[]>([]);
  const [sessionsHasMore, setSessionsHasMore] = createSignal(false);

  // Timeline.
  const [selectedSessionID, setSelectedSessionID] = createSignal<string | null>(null);
  const [timelineSession, setTimelineSession] = createSignal<SessionView | null>(null);
  const [messages, setMessages] = createSignal<MessageView[]>([]);
  const [nextCursor, setNextCursor] = createSignal<string | undefined>(undefined);
  const [timelineHasMore, setTimelineHasMore] = createSignal(false);
  const [timelinePartial, setTimelinePartial] = createSignal(false);
  const [timelineSource, setTimelineSource] = createSignal("");
  const messageRefs = new Map<string, HTMLElement>();

  const [attaching, setAttaching] = createSignal<string | null>(null);
  type QuoteToolbar = { messageID: string; text: string; top: number; left: number };
  const [quoteToolbar, setQuoteToolbar] = createSignal<QuoteToolbar | null>(null);
  let attachSeq = 0;

  const currentSession = (): RpcSession => props.session;
  const terms = createMemo(() => termsOf(query()));
  const groups = createMemo(() => groupHitsBySession(hits()));

  let restoredFor = "";
  let restoreSelected = false;
  let listGen = 0;
  let timelineGen = 0;
  let listController: AbortController | undefined;
  let timelineController: AbortController | undefined;

  const clientFor = (session: RpcSession) => ({
    client: session.server.client.rpc(MemoryRpc),
    options: { location: { directory: session.directory } },
  });

  const basename = (path?: string): string => {
    if (!path) return "";
    const clean = path.replace(/\/+$/, "");
    return clean.split("/").pop() || clean;
  };

  const projectLabel = (projectID?: string, directory?: string): string => {
    const project = projectID ? projects().find((entry) => entry.id === projectID) : undefined;
    return project?.name || basename(project?.canonical) || basename(directory) || projectID || t("allProjects");
  };

  const formatDate = (ms?: number): string => {
    if (!ms) return "";
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
  };

  const kindLabel = (kind: string): string =>
    kind === "user"
      ? t("kindUser")
      : kind === "assistant"
        ? t("kindAssistant")
        : kind === "summary"
          ? t("kindSummary")
          : t("kindOther");

  const kindTone = (kind: string): ChipTone =>
    kind === "user" ? "info" : kind === "assistant" ? "success" : "warning";

  const resetList = () => {
    setHits([]);
    setHitsHasMore(false);
    setSearchPartial(false);
    setVectorNote("");
    setSessions([]);
    setSessionsHasMore(false);
    setListPage(0);
  };

  const closeTimeline = () => {
    timelineController?.abort();
    timelineController = undefined;
    timelineGen++;
    setSelectedSessionID(null);
    setTimelineSession(null);
    setMessages([]);
    setNextCursor(undefined);
    setTimelineHasMore(false);
    setTimelinePartial(false);
    setTimelineSource("");
    messageRefs.clear();
    setQuoteToolbar(null);
  };

  const loadList = async (page = 0, reset = false) => {
    const gen = ++listGen;
    listController?.abort();
    const controller = new AbortController();
    listController = controller;
    setError("");
    setLoading(true);
    if (reset) {
      closeTimeline();
      resetList();
    }

    const session = currentSession();
    if (!session) {
      resetList();
      setStatus(null);
      setLoading(false);
      return;
    }

    const current = Math.max(0, Math.floor(page));
    const offset = current * LIST_PAGE_SIZE;
    const { client, options } = clientFor(session);
    const callOptions = { ...options, signal: controller.signal };
    const scope = projectOnly() ? "project" : "all";
    const q = query().trim();

    // Status is independent of the list; a failure must not hide results.
    if (current === 0) {
      void client
        .status({ sessionID: session.id }, callOptions)
        .then((next) => {
          if (gen === listGen) setStatus(next);
        })
        .catch(() => {
          if (gen === listGen) setStatus(null);
        });
    }

    try {
      if (q) {
        const result = await client.search(
          {
            query: q,
            scope,
            sessionID: session.id,
            limit: LIST_PAGE_SIZE,
            offset,
            backfill: current === 0,
          },
          callOptions,
        );
        if (gen !== listGen) return;
        setHits((previous) =>
          current === 0
            ? [...result.hits]
            : [...previous, ...result.hits.filter((hit) => !previous.some((item) => item.id === hit.id))],
        );
        setHitsHasMore(result.hasMore);
        setSearchPartial(result.partial);
        setVectorNote(result.vectorNote ?? "");
      } else {
        const result = await client.sessions(
          { scope, sessionID: session.id, limit: LIST_PAGE_SIZE, offset },
          callOptions,
        );
        if (gen !== listGen) return;
        setSessions((previous) =>
          current === 0
            ? [...result.sessions]
            : [...previous, ...result.sessions.filter((item) => !previous.some((old) => old.id === item.id))],
        );
        setSessionsHasMore(result.hasMore);
      }
      if (gen === listGen) {
        setListPage(current);
      }
    } catch (cause) {
      if (gen === listGen && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (gen === listGen) setLoading(false);
    }
  };

  const reload = () => loadList(0, true);

  const loadMoreList = () => {
    if (loading()) return;
    if (!(query().trim() ? hitsHasMore() : sessionsHasMore())) return;
    void loadList(listPage() + 1);
  };

  const loadTimeline = async (cursor?: string, replace = false) => {
    const session = currentSession();
    const sessionID = selectedSessionID();
    if (!session || !sessionID) return;
    const gen = ++timelineGen;
    timelineController?.abort();
    const controller = new AbortController();
    timelineController = controller;
    setLoadingMore(true);
    setError("");
    const { client, options } = clientFor(session);
    try {
      const result = await client.timeline(
        { sessionID, cursor, limit: 40, order: "asc" },
        { ...options, signal: controller.signal },
      );
      if (gen !== timelineGen) return;
      setTimelineSession(result.session);
      setMessages((previous) => {
        if (replace) {
          messageRefs.clear();
          return result.messages.map((message) => ({ ...message, files: [...message.files] }));
        }
        const seen = new Set(previous.map((message) => message.id));
        const fresh = result.messages
          .filter((message) => !seen.has(message.id))
          .map((message) => ({ ...message, files: [...message.files] }));
        return [...previous, ...fresh];
      });
      setNextCursor(result.nextCursor);
      setTimelineHasMore(result.hasMore);
      setTimelinePartial(result.partial);
      setTimelineSource(result.source);
    } catch (cause) {
      if (gen === timelineGen && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (gen === timelineGen) setLoadingMore(false);
    }
  };

  const openTimeline = (session: SessionView) => {
    setSelectedSessionID(session.id);
    setTimelineSession(session);
    setMessages([]);
    setNextCursor(undefined);
    setTimelineHasMore(false);
    setTimelinePartial(false);
    setTimelineSource("");
    messageRefs.clear();
    setQuoteToolbar(null);
    void loadTimeline(undefined, true);
  };

  const loadMoreTimeline = () => {
    if (loadingMore() || !timelineHasMore() || !nextCursor()) return;
    void loadTimeline(nextCursor());
  };

  interface QuoteTarget {
    sessionID: string;
    messageID: string;
    title?: string | undefined;
    query?: string | undefined;
    rawText?: string | undefined;
    selection?: string | undefined;
    created?: number | undefined;
    kind?: string | undefined;
  }

  const addToContext = async (target: QuoteTarget): Promise<string | undefined> => {
    const routed = currentSession();
    const screen = ctx.screen.current();
    if (!routed || !screen) {
      ctx.toast.show({
        title: t("toast.noSession"),
        description: t("toast.noSessionHint"),
        variant: "error",
      });
      return undefined;
    }
    if (!screen.composer.quotable()) {
      ctx.toast.show({
        title: t("toast.contextUnavailable"),
        description: t("toast.contextUnavailableHint"),
        variant: "error",
      });
      return undefined;
    }

    setAttaching(target.messageID);
    try {
      let quoteText = "";
      let sourceTitle = target.title;
      if (target.selection) {
        // Quote exactly what the user selected; the offset is searched in the
        // raw message text so the agent can expand around the same spot.
        const total = target.rawText?.length ?? target.selection.length;
        const found = target.rawText ? target.rawText.indexOf(target.selection) : -1;
        const start = found >= 0 ? found : 0;
        const length = Math.min(target.selection.length, quoteChars());
        quoteText = buildQuote({
          sessionID: target.sessionID,
          messageID: target.messageID,
          title: target.title,
          kind: kindLabel(target.kind ?? "assistant"),
          created: target.created ?? 0,
          text: target.selection.slice(0, length),
          total,
          offset: start,
          length,
          start,
          end: start + length,
          limit: quoteChars(),
          selected: true,
        }, t);
      } else {
        const { client, options } = clientFor(routed);
        const content = await client.content(
          {
            sessionID: target.sessionID,
            messageID: target.messageID,
            query: target.query?.trim() || undefined,
            limit: quoteChars(),
          },
          options,
        );
        if (!content.text) {
          ctx.toast.show({ title: t("toast.contentError"), variant: "error" });
          return undefined;
        }
        quoteText = buildQuote({
          sessionID: target.sessionID,
          messageID: target.messageID,
          title: content.title ?? target.title,
          kind: kindLabel(content.kind),
          created: content.created,
          text: content.text,
          total: content.total,
          offset: content.offset,
          length: content.length,
          start: content.start,
          end: content.end,
          limit: quoteChars(),
          query: target.query,
        }, t);
        sourceTitle = content.title ?? target.title;
      }

      if (currentSession()?.id !== routed.id) {
        ctx.toast.show({
          title: t("toast.noSession"),
          description: t("toast.noSessionHint"),
          variant: "error",
        });
        return undefined;
      }
      if (!quoteText) {
        ctx.toast.show({ title: t("toast.contentError"), variant: "error" });
        return undefined;
      }
      const commentID = `memory-${target.messageID}-${++attachSeq}`;
      screen.composer.attach({
        type: "quote",
        commentID,
        text: quoteText,
        source: {
          label: t("sourceLabel", sourceTitle ?? target.sessionID),
          icon: "file-document",
          subject: "the memory of a past session",
        },
      });
      ctx.toast.show({
        title: t("toast.attached"),
        description: t("toast.attachedHint"),
        variant: "success",
      });
      return commentID;
    } catch (cause) {
      ctx.toast.show({
        title: t("toast.attachError"),
        description: cause instanceof Error ? cause.message : String(cause),
        variant: "error",
      });
      return undefined;
    } finally {
      setAttaching(null);
    }
  };

  const quoteToolbarSelection = (toolbar: QuoteToolbar) => {
    const message = messages().find((entry) => entry.id === toolbar.messageID);
    const sessionID = timelineSession()?.id ?? selectedSessionID();
    if (!sessionID) return;
    setQuoteToolbar(null);
    window.getSelection()?.removeAllRanges();
    void addToContext({
      sessionID,
      messageID: toolbar.messageID,
      title: timelineSession()?.title,
      query: query(),
      rawText: message?.text,
      selection: toolbar.text,
      created: message?.created,
      kind: message?.kind,
    }).then((commentID) => {
      // Same behavior as the native "Quote": attach and open its comment editor.
      if (commentID) ctx.screen.current()?.composer.focus(commentID);
    });
  };

  // Projects: the official app API, never the OpenCode database.
  let projectsGen = 0;
  createEffect(() => {
    ctx.sessions.list();
    const gen = ++projectsGen;
    ctx.client.project.list().then(
      (list) => {
        if (gen !== projectsGen) return;
        setProjects(
          list.map((project) => ({
            id: project.id,
            canonical: project.canonical,
            ...(project.name ? { name: project.name } : {}),
          })),
        );
      },
      () => {
        if (gen === projectsGen) setProjects([]);
      },
    );
  });

  // Native-style selection toolbar: selecting text inside a message shows a
  // floating Quote action, like the session timeline does.
  createEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    const close = () => setQuoteToolbar(null);
    const read = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return close();
      const text = selection.toString().trim();
      if (!text) return close();
      for (const [messageID, element] of messageRefs) {
        if (!element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) continue;
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return close();
        setQuoteToolbar({
          messageID,
          text,
          top: Math.min(window.innerHeight - 52, rect.bottom + 6),
          left: Math.min(window.innerWidth - 160, Math.max(8, rect.left)),
        });
        return;
      }
      close();
    };
    const onSelectionChange = () => {
      clearTimeout(timer);
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return close();
      timer = setTimeout(read, 120);
    };
    const onViewportChange = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        read();
      });
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    onCleanup(() => {
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    });
  });

  // Hydrate this panel from the session's stored view. Runs before the
  // reload effect, so a restored conversation is not closed on mount.
  createEffect(() => {
    const id = props.session.id;
    if (restoredFor === id) return;
    restoredFor = id;
    const saved = props.store.value?.sessions[id];
    restoreSelected = Boolean(saved?.selected);
    setQuery(saved?.query ?? "");
    setProjectOnly(saved?.projectOnly ?? true);
    setQuoteChars(saved?.quoteChars ?? QUOTE_CHARS_DEFAULT);
    setSelectedSessionID(saved?.selected?.id ?? null);
    setTimelineSession(saved?.selected ?? null);
    setMessages([]);
    setNextCursor(undefined);
    setTimelineHasMore(false);
    setTimelinePartial(false);
    setTimelineSource("");
    messageRefs.clear();
    setQuoteToolbar(null);
    setHydratedSession(id);
  });

  // Reload when the routed session, scope, query or refresh key changes.
  createEffect(() => {
    query();
    projectOnly();
    props.session.id;
    if (hydratedSession() !== props.session.id) return;
    const restore = restoreSelected;
    const timer = setTimeout(() => {
      if (restore) {
        restoreSelected = false;
        setQuoteToolbar(null);
        void loadTimeline(undefined, true);
      } else {
        void reload();
      }
    }, 200);
    onCleanup(() => clearTimeout(timer));
  });

  // Persist the panel state for this routed session.
  createEffect(() => {
    const id = props.session.id;
    if (restoredFor !== id) return;
    const entry: ViewEntry = {
      query: query(),
      projectOnly: projectOnly(),
      quoteChars: quoteChars(),
      paginated: false,
      ...(timelineSession() ? { selected: timelineSession()! } : {}),
    };
    props.store.update((draft) => {
      draft.sessions[id] = entry;
    });
  });

  // Infinite scroll and keyboard navigation for the shared scroll container.
  const nav = createScrollNav({
    hasMore: () =>
      selectedSessionID()
        ? timelineHasMore()
        : query().trim()
          ? hitsHasMore()
          : sessionsHasMore(),
    loadingMore: () => (selectedSessionID() ? loadingMore() : loading()),
    loadMore: () => {
      if (selectedSessionID()) loadMoreTimeline();
      else loadMoreList();
    },
    visible: () => panel.visible(),
    items: () =>
      selectedSessionID()
        ? messages().length
        : query().trim()
          ? hits().length
          : sessions().length,
  });
  onCleanup(() => {
    listController?.abort();
    timelineController?.abort();
  });

  // A new query or scope starts from the top of the list.
  createEffect(() => {
    query();
    projectOnly();
    nav.toTop();
  });

  const refresh = () => {
    if (selectedSessionID()) {
      setQuoteToolbar(null);
      void loadTimeline(undefined, true);
    } else {
      void loadList(listPage());
    }
  };

  const back = () => {
    const empty = hits().length === 0 && sessions().length === 0;
    closeTimeline();
    if (empty) void reload();
  };

  const totalCount = createMemo(() => (query().trim() ? groups().length : sessions().length));

  return (
    <div class="mem">
      <style>{CSS}</style>
      <style>{SHARED_CSS}</style>

      <div class="mem-head">
        <div>
          <div class="mem-title">
            <ctx.ui.Icon name="brain" size="small" />
            <h2 class="mem-title-text">{t("title")}</h2>
            <span class="mem-sub">{t("resultsCount", totalCount())}</span>
          </div>
          <div class="mem-sub">{t("subtitle")}</div>
        </div>
        <div class="mem-actions">
          <ctx.ui.IconButton
            icon="outline-rotate-clockwise"
            label={t("refresh")}
            onClick={refresh}
          />
        </div>
      </div>

      <Show when={!selectedSessionID()}>
        <div class="mem-controls">
          <div class="mem-search">
            <ctx.ui.TextInput
              type="search"
              label={t("searchLabel")}
              placeholder={t("searchPlaceholder")}
              value={query()}
              onInput={setQuery}
            />
            <Show when={query().length > 0}>
              <span onMouseDown={(event) => event.preventDefault()}>
                <ctx.ui.IconButton
                  icon="outline-xmark"
                  label={t("clearSearch")}
                  variant="ghost-muted"
                  size="small"
                  class="mem-search-clear"
                  onClick={() => setQuery("")}
                />
              </span>
            </Show>
          </div>
          <div class="mem-row">
            <button
              type="button"
              class="mem-toggle"
              classList={{ "is-active": projectOnly() }}
              title={t("projectOnlyHint")}
              onClick={() => setProjectOnly((value) => !value)}
            >
              {t("projectOnly")}
            </button>
            <select
              class="mem-select"
              title={t("quoteCharsHint")}
              value={String(quoteChars())}
              onChange={(event) => setQuoteChars(Number(event.currentTarget.value))}
            >
              <For each={QUOTE_CHARS_OPTIONS}>
                {(size) => <option value={String(size)}>{t("quoteChars")}: {size}</option>}
              </For>
            </select>
          </div>
          <Show when={status()}>
            {(value) => (
              <div class="mem-status">
                {t("indexStatus", value().documents, value().summaries)} · {t("backend", value().backend)}
                {value().error ? ` · ${value().error}` : ""}
              </div>
            )}
          </Show>
        </div>
      </Show>

      <Show when={selectedSessionID()}>
        <div class="mem-conversation-bar">
          <button type="button" class="mem-back" onClick={back}>
            ← {t("back")}
          </button>
        </div>
      </Show>

      <Show when={error()}>
        <ErrorBanner message={error()} />
      </Show>

      <div class="mem-body">
        <div
          class="mem-scroll os-scroll os-list"
          ref={nav.ref}
          onKeyDown={nav.onKeyDown}
          tabIndex={nav.scrollable() ? 0 : undefined}
          role="region"
          aria-label={t("scroll.region")}
        >
        <Show when={!selectedSessionID()}>
          <Show when={loading() && hits().length === 0 && sessions().length === 0}>
            <LoadingRow label={t("loading")} />
          </Show>

          <Show when={query().trim()}>
            <div class="mem-section-title">{t("resultsCount", groups().length)}</div>
            <Show when={!loading() && groups().length === 0}>
              <EmptyState title={t("searchEmpty")} hint={t("searchHint")} />
            </Show>
            <For each={groups()}>
              {(group) => (
                <div class="mem-group">
                  <div class="mem-group-head">
                    <div class="mem-group-info">
                      <div class="mem-group-title">{group.title || group.sessionID}</div>
                      <div class="mem-group-meta">
                        {projectLabel(group.projectID)} · {formatDate(group.updated)} · {t("matches", group.total)}
                      </div>
                    </div>
                    <ctx.ui.Button
                      size="small"
                      variant="ghost"
                      icon="file-document"
                      onClick={() =>
                        openTimeline({
                          id: group.sessionID,
                          projectID: group.projectID,
                          ...(group.title ? { title: group.title } : {}),
                          updated: group.updated,
                        })
                      }
                    >
                      {t("openConversation")}
                    </ctx.ui.Button>
                  </div>
                  <For each={group.hits}>
                    {(hit) => (
                      <div class="mem-hit">
                        <div class="mem-hit-meta">
                          {kindLabel(hit.kind)} · {formatDate(hit.created)}
                          {hit.agent ? ` · ${hit.agent}` : ""}
                          {hit.via ? ` · ${hit.via}` : ""}
                        </div>
                        <div class="mem-hit-text">
                          <For each={highlightParts(hit.snippet, terms())}>
                            {(part) =>
                              part.match ? <mark>{part.text}</mark> : <span>{part.text}</span>
                            }
                          </For>
                        </div>
                        <div class="mem-hit-actions">
                          <ctx.ui.Button
                            size="small"
                            variant="ghost"
                            icon="plus"
                            busy={attaching() === hit.messageID}
                            onClick={() =>
                              void addToContext({
                                sessionID: hit.sessionID,
                                messageID: hit.messageID ?? hit.id,
                                title: group.title,
                                query: query(),
                              })
                            }
                          >
                            {t("addToContext")}
                          </ctx.ui.Button>
                        </div>
                      </div>
                    )}
                  </For>
                  <Show when={group.total > group.hits.length}>
                    <div class="mem-more">{t("moreMatches", group.total - group.hits.length)}</div>
                  </Show>
                </div>
              )}
            </For>
            <Show when={searchPartial()}>
              <div class="mem-note">{t("partial")}</div>
            </Show>
            <Show when={vectorNote()}>
              <div class="mem-note">{vectorNote()}</div>
            </Show>
          </Show>

          <Show when={!query().trim()}>
            <div class="mem-section-title">{t("recentTitle")}</div>
            <Show when={!loading() && sessions().length === 0}>
              <EmptyState title={t("recentEmpty")} />
            </Show>
            <For each={sessions()}>
              {(session) => (
                <button type="button" class="mem-session" onClick={() => openTimeline(session)}>
                  <div class="mem-session-title">{session.title || session.id}</div>
                  <div class="mem-session-meta">
                    {projectLabel(session.projectID, session.directory)} ·{" "}
                    {formatDate(session.updated ?? session.created)}
                  </div>
                  <Show when={session.directory}>
                    <div class="mem-session-dir">{session.directory}</div>
                  </Show>
                </button>
              )}
            </For>
          </Show>

        </Show>

        <Show when={selectedSessionID()}>
          <div class="mem-timeline-head">
            <div class="mem-timeline-head-row">
              <div class="mem-timeline-title">
                {timelineSession()?.title || timelineSession()?.id || t("conversation")}
              </div>
            </div>
            <div class="mem-timeline-meta">
              {projectLabel(timelineSession()?.projectID, timelineSession()?.directory)}
              {timelineSession()?.updated || timelineSession()?.created
                ? ` · ${formatDate(timelineSession()?.updated ?? timelineSession()?.created)}`
                : ""}
            </div>
          </div>
          <div class="mem-note">{t("selectionHint")}</div>
          <Show when={timelinePartial()}>
            <div class="mem-note">
              {t("partial")} ({timelineSource()})
            </div>
          </Show>
          <For each={messages()}>
            {(message) => (
              <div
                class="mem-msg"
                ref={(element) => {
                  if (element) messageRefs.set(message.id, element);
                  else messageRefs.delete(message.id);
                }}
              >
                <div class="mem-msg-head">
                  <StatusChip tone={kindTone(message.kind)} label={kindLabel(message.kind)} />
                  <span class="mem-msg-meta">
                    {formatDate(message.created)}
                    {message.agent ? ` · ${message.agent}` : ""}
                    {message.model ? ` · ${message.model}` : ""}
                  </span>
                  <Show when={message.hasTools}>
                    <span class="mem-badge">{t("toolsHidden")}</span>
                  </Show>
                </div>
                <ctx.ui.Markdown text={message.text} class="mem-msg-text" />
                <div class="mem-msg-actions">
                  <ctx.ui.Button
                    size="small"
                    variant="ghost"
                    icon="plus"
                    busy={attaching() === message.id}
                    onClick={() =>
                      void addToContext({
                        sessionID: timelineSession()?.id ?? selectedSessionID()!,
                        messageID: message.id,
                        title: timelineSession()?.title,
                        query: query(),
                        created: message.created,
                        kind: message.kind,
                      })
                    }
                  >
                    {t("addToContext")}
                  </ctx.ui.Button>
                </div>
              </div>
            )}
          </For>
          <Show when={!loadingMore() && messages().length === 0}>
            <EmptyState title={t("noMessages")} />
          </Show>
        </Show>

        <Show when={loadingMore()}>
          <LoadingRow label={t("loadingMore")} />
        </Show>
        <Show
          when={
            selectedSessionID() &&
            !loading() &&
            !loadingMore() &&
            !timelineHasMore()
          }
        >
          <EndMarker label={t("end")} />
        </Show>
        <div class="mem-sentinel" ref={nav.sentinelRef} />
        </div>

        <ScrollNav nav={nav} topLabel={t("scroll.top")} bottomLabel={t("scroll.bottom")} />
      </div>

      <Show when={quoteToolbar()}>
        {(toolbar) => (
          <Portal>
            <div
              class="mem-quote-toolbar"
              role="toolbar"
              aria-label={t("quoteActions")}
              style={{ top: `${toolbar().top}px`, left: `${toolbar().left}px` }}
              onMouseDown={(event) => event.preventDefault()}
            >
              <ctx.ui.Button
                size="small"
                variant="ghost"
                icon="outline-quote"
                onClick={() => quoteToolbarSelection(toolbar())}
              >
                {t("quote")}
              </ctx.ui.Button>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
}
