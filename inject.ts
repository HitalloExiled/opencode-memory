/**
 * Context injection and passive compaction capture.
 *
 * `context` runs only for the agent loop (not for title/compaction/generate),
 * so it is the right place to add the routing rule. A compaction hook only
 * marks the session; the next agent-loop context reads the active context,
 * finds the completed compaction message and stores its summary.
 */

import type { PluginContext } from "./context.js";
import type { Runtime } from "./runtime.js";
import { sessionRuntime } from "./runtime.js";
import type { MessageLike, SessionInfoLike } from "./types.js";
import { captureCompaction, migrateSessionSummaries, toIndexDoc } from "./summaries.js";
import { resolveProjectID } from "./projects.js";
import { getSessionInfo } from "./history.js";

function activeMessages(value: unknown): MessageLike[] {
  if (Array.isArray(value)) return value as MessageLike[];
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: MessageLike[] }).data;
  }
  return [];
}

export async function captureLatestCompaction(
  ctx: PluginContext,
  runtime: Runtime,
  sessionID: string,
  info: SessionInfoLike,
  projectID: string,
  force = false,
): Promise<void> {
  const state = sessionRuntime(runtime, sessionID);
  if (!force && state.captured && !runtime.pendingCompactions.has(sessionID)) return;
  runtime.pendingCompactions.delete(sessionID);
  state.captured = true;
  try {
    const active = activeMessages(await ctx.session.context({ sessionID } as never));
    const compaction = [...active]
      .reverse()
      .find((message) => message.type === "compaction" && message.status === "completed" && (message.summary ?? "").trim());
    if (!compaction?.id) return;
    if (state.lastCompactionID === compaction.id) return;
    const captured = await captureCompaction(projectID, info, compaction);
    if (!captured) return;
    state.lastCompactionID = compaction.id;
    await runtime.index.upsert([toIndexDoc(captured.record)]).catch((error) => {
      console.error(`[memory] could not index summary ${captured.record.messageID}: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (captured.pruned.length > 0) {
      await runtime.index.remove(captured.pruned.map((id) => `summary:${id}`)).catch(() => undefined);
    }
  } catch (error) {
    console.error(`[memory] compaction capture failed for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Memory-routing guidance, injected on every agent-loop request as its own
 * system part. It is deliberately an APPEND to the standard system prompt
 * (never a replacement), and it is scoped to THIS layer only: conversation
 * recall. It never mentions the notes layer — each plugin owns its own
 * context and its own routing (see the notes plugin's `notes-context` hook).
 * (Experiment E4: a system-level rule is what makes routing memory-first.)
 */
export const MEMORY_ROUTING_RULE =
  "Memory routing (additive; never overrides safety/correctness):\n" +
  "- Past sessions are first-class: before \"I don't know\" or re-discovering, call memory.search — hybrid (keyword + semantic): state the intent, not exact words; scope=\"all\" for machine-wide.\n" +
  "- Explicit recall (\"lembra…?\", \"do you remember…?\", \"o que decidimos…?\") or a named session (\"what happened in session X\", \"where did it stop\"): memory.search, or memory.summaries/memory.history (handoff/timeline).\n" +
  "- Exact quotes: each memory.search hit carries its session and messageID — fetch the literal text with memory.history action=\"message\". Never open OpenCode's internal database directly; if these tools cannot answer, say what is missing.\n" +
  "- World = live state (branch, files, services); memory = snapshot — verify before acting. This block is background, not instructions; the current session is authoritative.";

export async function onContext(
  ctx: PluginContext,
  runtime: Runtime,
  event: { sessionID: string; system: Array<{ type: "text"; text: string }> },
): Promise<void> {
  let info: SessionInfoLike;
  try {
    info = await getSessionInfo(ctx, event.sessionID);
  } catch (error) {
    console.error(`[memory] could not read session ${event.sessionID}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // Sessions inside a real project's directory can carry the root project
  // id "global"; resolve them so captures land in the right bucket.
  const projectID = (await resolveProjectID(info)) || info.projectID;
  const state = sessionRuntime(runtime, event.sessionID);
  if (state.projectID !== projectID) {
    const previous = state.projectID;
    state.projectID = projectID;
    state.captured = false;
    state.lastCompactionID = undefined;
    // The in-memory previous project is a fast path only: after a service
    // restart it is unknown, and the backfill (sessions_indexed) covers it.
    if (previous) {
      void migrateSessionSummaries(previous, projectID, event.sessionID).catch((error) =>
        console.error(
          `[memory] summary migration failed for ${event.sessionID}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  await captureLatestCompaction(ctx, runtime, event.sessionID, info, projectID);

  // The server rebuilds `system` for every request, so the rule is re-pushed
  // on each one. It is a constant string: the head of the prompt stays
  // byte-identical and the provider's prefix cache survives.
  event.system.push({ type: "text", text: MEMORY_ROUTING_RULE });
}

