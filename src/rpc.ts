/**
 * Server-side RPC handlers for the Memory panel.
 *
 * The desktop window calls these methods through the server that runs the
 * plugin, so the same hot-reloaded process that owns `index.db` and the
 * session-history access also serves the panel.
 */

import type { PluginContext } from "../context.js";
import type { RpcHandlers } from "@opencode/plugin/promise/rpc";
import {
  QUOTE_CHARS_DEFAULT,
  type ContentResult,
  type HitView,
  type MessageView,
  type SearchResult,
  type SessionList,
  type SessionView,
  type Status,
  type TimelineResult,
  MemoryRpc,
} from "./gui/contract.js";
import {
  listSessions,
  messageToView,
  readMessageContent,
  readPage,
} from "../history.js";
import { embedDisabled, embedModelName } from "../paths.js";
import { listProjects } from "../projects.js";
import { currentProject, resolveScopeProjectID } from "./scope.js";
import { searchMemory } from "./search.js";
import { listAllSummaries, listSummaries } from "../summaries.js";
import type { Runtime } from "../runtime.js";
import type { SearchHit } from "../types.js";
import { timeMs } from "../util.js";

type Ctx = PluginContext;

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

function toSessionView(session: {
  id: string;
  title?: string;
  projectID: string;
  location?: { directory?: string };
  time?: { created?: number; updated?: number };
}): SessionView {
  const created = timeMs(session.time?.created);
  const updated = timeMs(session.time?.updated);
  return {
    id: session.id,
    ...(session.title ? { title: session.title } : {}),
    projectID: session.projectID,
    ...(session.location?.directory ? { directory: session.location.directory } : {}),
    ...(created ? { created } : {}),
    ...(updated ? { updated } : {}),
  };
}

function toHitView(hit: SearchHit): HitView {
  return {
    id: hit.id,
    sessionID: hit.sessionID,
    projectID: hit.projectID,
    ...(hit.messageID ? { messageID: hit.messageID } : {}),
    kind: hit.kind,
    created: hit.created,
    ...(hit.title ? { title: hit.title } : {}),
    ...(hit.agent ? { agent: hit.agent } : {}),
    ...(hit.model ? { model: hit.model } : {}),
    snippet: hit.snippet,
    ...(hit.via ? { via: hit.via } : {}),
  };
}

export function createRpcHandlers(ctx: Ctx, runtime: Runtime): RpcHandlers<typeof MemoryRpc> {
  return {
    status: async (input): Promise<Status> => {
      const { projectID } = await resolveScopeProjectID(ctx, { sessionID: input.sessionID });
      const projects = await listProjects().catch(() => []);
      const project = projectID ? projects.find((entry) => entry.id === projectID) : undefined;
      const [documents, summaries] = await Promise.all([
        projectID ? runtime.index.count(projectID).catch(() => 0) : runtime.index.count().catch(() => 0),
        projectID ? listSummaries(projectID, 1000).catch(() => []) : listAllSummaries(1000).catch(() => []),
      ]);
      return {
        backend: runtime.index.backend,
        ...(runtime.index.error ? { error: runtime.index.error } : {}),
        projectID: projectID ?? "global",
        ...(project?.name ? { projectName: project.name } : {}),
        ...(project?.canonical ? { projectCanonical: project.canonical } : {}),
        documents,
        summaries: summaries.length,
        embedModel: embedModelName(),
        embedDisabled: embedDisabled(),
      };
    },

    sessions: async (input): Promise<SessionList> => {
      const { projectID } = await resolveScopeProjectID(ctx, { sessionID: input.sessionID });
      const limit = clamp(input.limit, 20, 1, 99);
      const offset = clamp(input.offset, 0, 0, 5000);
      // Ask for one extra session to know whether another page exists.
      const sessions = await listSessions(ctx, {
        projectID,
        scope: input.scope,
        limit: limit + 1,
        offset,
      });
      return {
        sessions: sessions.slice(0, limit).map(toSessionView),
        hasMore: sessions.length > limit,
      };
    },

    search: async (input): Promise<SearchResult> => {
      const { projectID } = await resolveScopeProjectID(ctx, { sessionID: input.sessionID });
      const limit = clamp(input.limit, 20, 1, 50);
      const offset = clamp(input.offset, 0, 0, 5000);
      const result = await searchMemory(runtime, {
        projectID,
        scope: input.scope,
        query: input.query,
        kind: input.kind,
        limit,
        offset,
        backfill: input.backfill,
      });
      return {
        hits: result.hits.map(toHitView),
        hasMore: result.hasMore,
        partial: result.partial,
        ...(result.vectorNote ? { vectorNote: result.vectorNote } : {}),
        ...(projectID ? { projectID } : {}),
      };
    },

    timeline: async (input): Promise<TimelineResult> => {
      const current = await currentProject(ctx, input.sessionID);
      const read = await readPage(ctx, input.sessionID, {
        limit: clamp(input.limit, 40, 1, 100),
        order: input.order ?? "asc",
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      const messages: MessageView[] = [];
      for (const message of read.page.data) {
        const view = messageToView(message);
        if (view) messages.push({ ...view, kind: view.kind as string });
      }
      const next = read.page.cursor?.next;
      return {
        session: toSessionView(current.info),
        messages,
        ...(next ? { nextCursor: next } : {}),
        hasMore: Boolean(next),
        partial: read.partial,
        source: read.source,
      };
    },

    content: async (input): Promise<ContentResult> => {
      const current = await currentProject(ctx, input.sessionID);
      // Message docs use the message id; summary docs use `summary:<messageID>`.
      const fallback = await runtime.index
        .docsByIds([input.messageID, `summary:${input.messageID}`])
        .catch(() => []);
      const fallbackText =
        fallback.find((doc) => doc.messageID === input.messageID)?.text ?? fallback[0]?.text;
      const content = await readMessageContent(ctx, input.sessionID, input.messageID, {
        query: input.query,
        offset: input.offset,
        limit: clamp(input.limit, QUOTE_CHARS_DEFAULT, 1, 8000),
        includeTools: input.includeTools,
        includeReasoning: input.includeReasoning,
        fallbackText,
      });
      return {
        sessionID: input.sessionID,
        messageID: input.messageID,
        ...(current.projectID ? { projectID: current.projectID } : {}),
        ...(current.info.title ? { title: current.info.title } : {}),
        text: content.text,
        total: content.total,
        offset: content.offset,
        length: content.length,
        start: content.start,
        end: content.end,
        kind: content.kind,
        created: content.created,
        ...(content.agent ? { agent: content.agent } : {}),
        ...(content.model ? { model: content.model } : {}),
      };
    },
  };
}
