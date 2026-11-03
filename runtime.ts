/** Per-process state shared by hooks, tools and commands. */

import type { PluginContext } from "./context.js";
import type { MemoryIndex } from "./index-db.js";

/** Rendered system parts, cached so every request carries identical bytes. */
export interface SessionInjection {
  block: string;
  rule: string;
}

export interface SessionRuntime {
  projectID?: string;
  /**
   * Rendered once per session (and re-rendered on a project change or a new
   * compaction). Reusing it keeps the head of the prompt byte-stable: the
   * server rebuilds `system` per request, so anything that changes there
   * invalidates the provider's prefix cache from that point on.
   */
  injection?: SessionInjection;
  captured: boolean;
  lastCompactionID?: string;
}

export interface Runtime {
  readonly ctx: PluginContext;
  readonly index: MemoryIndex;
  readonly pendingCompactions: Set<string>;
  readonly sessions: Map<string, SessionRuntime>;
  readonly backfills: Map<string, Promise<{ sessions: number; messages: number; partial: boolean }>>;
  readonly backfilled: Set<string>;
}

export function createRuntime(ctx: PluginContext, index: MemoryIndex): Runtime {
  return {
    ctx,
    index,
    pendingCompactions: new Set(),
    sessions: new Map(),
    backfills: new Map(),
    backfilled: new Set(),
  };
}

export function sessionRuntime(runtime: Runtime, sessionID: string): SessionRuntime {
  let state = runtime.sessions.get(sessionID);
  if (!state) {
    state = { captured: false };
    runtime.sessions.set(sessionID, state);
    // Bound the map; old sessions are recreated lazily if they come back.
    if (runtime.sessions.size > 500) {
      const oldest = runtime.sessions.keys().next().value;
      if (oldest) runtime.sessions.delete(oldest);
    }
  }
  return state;
}
