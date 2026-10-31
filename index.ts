/**
 * memory plugin (formerly agent-toolbelt).
 *
 * - Captures every completed compaction summary as a Markdown file under XDG data.
 * - Injects the repository state and the previous session handoff once per session.
 * - Exposes read-only tools to search summaries and past conversations.
 */

import { Plugin } from "@opencode/plugin";
import { registerCommands } from "./commands.js";
import { openIndex } from "./index-db.js";
import { onContext } from "./inject.js";
import { createRuntime } from "./runtime.js";
import { ensureDataDirs } from "./storage.js";
import { registerTools } from "./tools.js";

export default Plugin.define({
  id: "memory",
  async setup(ctx) {
    await ensureDataDirs().catch((error) => {
      console.error(`[memory] data directory unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });

    const index = await openIndex();
    const runtime = createRuntime(ctx, index);

    const registrations = await Promise.all([
      registerTools(ctx, runtime),
      registerCommands(ctx),
      ctx.session.hook("compaction", (event) => {
        // The summary does not exist yet; mark the session and read it on the
        // next agent-loop context.
        runtime.pendingCompactions.add(event.sessionID);
        // The compaction is the consolidation moment, so it is the natural
        // checkpoint for durable facts (deterministic: the agent cannot skip
        // it, unlike a "before you finish" nudge). Always add a "Durable facts
        // learned" section request to the compaction prompt — text-only, safe
        // even if the compaction pass cannot call tools; the post-compaction
        // agent turn then persists them per MEMORY_ROUTING_RULE. If
        // MEMORY_COMPACT_DURING=1, also ask the model to record them DIRECTLY
        // during compaction (only works if that pass can call tools) — this
        // is the A/B axis (before vs. after compaction).
        event.system.push({
          type: "text",
          text:
            "Before producing your summary, scan this conversation for NEW durable world/user facts (user identity, machine facts such as binary paths/versions/ports/quirks, or ongoing work). Your summary MUST end with a section titled 'Durable facts learned' listing each such fact on its own line, verbatim — or a single line 'Durable facts learned: None.' if there were none. These facts will be persisted with memory.facts remember.",
        });
        if (process.env.MEMORY_COMPACT_DURING?.trim() === "1") {
          event.system.push({
            type: "text",
            text:
              "ALSO, before summarizing, call memory.facts list, and for each NEW durable world/user fact call memory.facts remember to record it directly (dedup in place via its id).",
          });
        }
      }),
      ctx.session.hook("context", async (event) => {
        await onContext(ctx, runtime, { sessionID: event.sessionID, system: event.system });
      }),
    ]);

    return async () => {
      for (const registration of registrations) {
        await registration.dispose().catch(() => undefined);
      }
      await index.close().catch(() => undefined);
    };
  },
});
