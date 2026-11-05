/**
 * Persisted Memory panel state.
 *
 * One entry per routed session: the search filters, the selected past
 * conversation, and the pagination mode. Reopening the tab restores the
 * conversation instead of dropping back to the listing.
 */

import { Store } from "@opencode/plugin/gui";
import { Schema } from "effect";

export const SessionViewSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  projectID: Schema.String,
  directory: Schema.optional(Schema.String),
  created: Schema.optional(Schema.Number),
  updated: Schema.optional(Schema.Number),
});

export type SessionViewState = Schema.Schema.Type<typeof SessionViewSchema>;

export const ViewEntrySchema = Schema.Struct({
  query: Schema.String,
  projectOnly: Schema.Boolean,
  quoteChars: Schema.Number,
  paginated: Schema.Boolean,
  selected: Schema.optional(SessionViewSchema),
});

export type ViewEntry = Schema.Schema.Type<typeof ViewEntrySchema>;

export const ViewStateSchema = Schema.Struct({
  sessions: Schema.Record(Schema.String, ViewEntrySchema),
});

export type ViewState = Schema.Schema.Type<typeof ViewStateSchema>;

export const VIEW_INITIAL: ViewState = { sessions: {} };

/** The declared store, shared by the GUI definition and the setup type. */
export const viewStore = Store.global(ViewStateSchema, VIEW_INITIAL);
export type MemoryStores = { view: typeof viewStore };
