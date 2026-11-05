/**
 * Memory GUI/server contract.
 *
 * The window never opens `index.db` or the OpenCode database: the server
 * plugin owns both the derived index and the session-history access, so the
 * panel talks to it over RPC (same pattern as the Plans panel).
 */

import { Rpc } from "@opencode/schema/rpc";
import { Schema } from "effect";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type Scope = "project" | "all";
export type SearchKind = "any" | "user" | "assistant" | "summary";

export type Status = {
  backend: string;
  error?: string | undefined;
  projectID: string;
  projectName?: string | undefined;
  projectCanonical?: string | undefined;
  documents: number;
  summaries: number;
  embedModel: string;
  embedDisabled: boolean;
};

export type SessionView = {
  id: string;
  title?: string | undefined;
  projectID: string;
  directory?: string | undefined;
  created?: number | undefined;
  updated?: number | undefined;
};

export type SessionList = {
  sessions: SessionView[];
  hasMore: boolean;
};

export type HitView = {
  id: string;
  sessionID: string;
  projectID: string;
  messageID?: string | undefined;
  kind: string;
  created: number;
  title?: string | undefined;
  agent?: string | undefined;
  model?: string | undefined;
  snippet: string;
  via?: string | undefined;
};

export type SearchResult = {
  hits: HitView[];
  hasMore: boolean;
  partial: boolean;
  vectorNote?: string | undefined;
  projectID?: string | undefined;
};

export type MessageView = {
  id: string;
  type: string;
  kind: string;
  created: number;
  text: string;
  agent?: string | undefined;
  model?: string | undefined;
  files: string[];
  hasTools: boolean;
};

export type TimelineResult = {
  session: SessionView;
  messages: MessageView[];
  nextCursor?: string | undefined;
  previousCursor?: string | undefined;
  hasMore: boolean;
  partial: boolean;
  source: string;
};

export type ContentResult = {
  sessionID: string;
  messageID: string;
  projectID?: string | undefined;
  title?: string | undefined;
  text: string;
  total: number;
  offset: number;
  length: number;
  start: number;
  end: number;
  kind: string;
  created: number;
  agent?: string | undefined;
  model?: string | undefined;
};

export type StatusInput = {
  sessionID?: string | undefined;
};

export type SessionsInput = {
  scope: Scope;
  sessionID?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
};

export type SearchInput = {
  query: string;
  scope: Scope;
  sessionID?: string | undefined;
  kind?: SearchKind | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  backfill?: boolean | undefined;
};

export type TimelineInput = {
  sessionID: string;
  cursor?: string | undefined;
  limit?: number | undefined;
  order?: "asc" | "desc" | undefined;
};

export type ContentInput = {
  sessionID: string;
  messageID: string;
  query?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
  includeTools?: boolean | undefined;
  includeReasoning?: boolean | undefined;
};

/** Default quote size, in characters. */
export const QUOTE_CHARS_DEFAULT = 2000;
export const QUOTE_CHARS_OPTIONS = [1000, 2000, 4000] as const;

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const optString = Schema.optional(Schema.String);
const optNum = Schema.optional(Schema.Number);
const optBool = Schema.optional(Schema.Boolean);

export const scopeSchema = Schema.Union([Schema.Literal("project"), Schema.Literal("all")]);
export const searchKindSchema = Schema.Union([
  Schema.Literal("any"),
  Schema.Literal("user"),
  Schema.Literal("assistant"),
  Schema.Literal("summary"),
]);

export const statusSchema = Schema.Struct({
  backend: Schema.String,
  error: optString,
  projectID: Schema.String,
  projectName: optString,
  projectCanonical: optString,
  documents: Schema.Number,
  summaries: Schema.Number,
  embedModel: Schema.String,
  embedDisabled: Schema.Boolean,
});

export const sessionViewSchema = Schema.Struct({
  id: Schema.String,
  title: optString,
  projectID: Schema.String,
  directory: optString,
  created: optNum,
  updated: optNum,
});

export const sessionListSchema = Schema.Struct({
  sessions: Schema.Array(sessionViewSchema),
  hasMore: Schema.Boolean,
});

export const hitViewSchema = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  projectID: Schema.String,
  messageID: optString,
  kind: Schema.String,
  created: Schema.Number,
  title: optString,
  agent: optString,
  model: optString,
  snippet: Schema.String,
  via: optString,
});

export const searchResultSchema = Schema.Struct({
  hits: Schema.Array(hitViewSchema),
  hasMore: Schema.Boolean,
  partial: Schema.Boolean,
  vectorNote: optString,
  projectID: optString,
});

export const messageViewSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  kind: Schema.String,
  created: Schema.Number,
  text: Schema.String,
  agent: optString,
  model: optString,
  files: Schema.Array(Schema.String),
  hasTools: Schema.Boolean,
});

export const timelineResultSchema = Schema.Struct({
  session: sessionViewSchema,
  messages: Schema.Array(messageViewSchema),
  nextCursor: optString,
  previousCursor: optString,
  hasMore: Schema.Boolean,
  partial: Schema.Boolean,
  source: Schema.String,
});

export const contentResultSchema = Schema.Struct({
  sessionID: Schema.String,
  messageID: Schema.String,
  projectID: optString,
  title: optString,
  text: Schema.String,
  total: Schema.Number,
  offset: Schema.Number,
  length: Schema.Number,
  start: Schema.Number,
  end: Schema.Number,
  kind: Schema.String,
  created: Schema.Number,
  agent: optString,
  model: optString,
});

export const statusInputSchema = Schema.Struct({
  sessionID: optString,
});

export const sessionsInputSchema = Schema.Struct({
  scope: scopeSchema,
  sessionID: optString,
  limit: optNum,
  offset: optNum,
});

export const searchInputSchema = Schema.Struct({
  query: Schema.String,
  scope: scopeSchema,
  sessionID: optString,
  kind: Schema.optional(searchKindSchema),
  limit: optNum,
  offset: optNum,
  backfill: optBool,
});

export const timelineInputSchema = Schema.Struct({
  sessionID: Schema.String,
  cursor: optString,
  limit: optNum,
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])),
});

export const contentInputSchema = Schema.Struct({
  sessionID: Schema.String,
  messageID: Schema.String,
  query: optString,
  offset: optNum,
  limit: optNum,
  includeTools: optBool,
  includeReasoning: optBool,
});

/* ------------------------------------------------------------------ */
/* The RPC                                                             */
/* ------------------------------------------------------------------ */

export const MemoryRpc = Rpc.define({
  id: "opencode.memory",
  methods: {
    status: {
      input: Schema.toStandardSchemaV1(statusInputSchema),
      output: Schema.toStandardSchemaV1(statusSchema),
    },
    sessions: {
      input: Schema.toStandardSchemaV1(sessionsInputSchema),
      output: Schema.toStandardSchemaV1(sessionListSchema),
    },
    search: {
      input: Schema.toStandardSchemaV1(searchInputSchema),
      output: Schema.toStandardSchemaV1(searchResultSchema),
    },
    timeline: {
      input: Schema.toStandardSchemaV1(timelineInputSchema),
      output: Schema.toStandardSchemaV1(timelineResultSchema),
    },
    content: {
      input: Schema.toStandardSchemaV1(contentInputSchema),
      output: Schema.toStandardSchemaV1(contentResultSchema),
    },
  },
  events: {},
});
