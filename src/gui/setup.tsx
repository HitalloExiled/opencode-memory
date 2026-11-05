/**
 * Window-side registration for the Memory side panel.
 *
 * Registers a removable "Memory" tab in the session's side region, a command
 * palette / keybind entry, and a "+ / New tab" menu entry.
 */

import { createMemo } from "solid-js";
import type {
  Panel as PanelType,
  PanelTab,
  SessionPanelMenuItem,
  SetupContext,
} from "@opencode/plugin/gui";
import { Command, MenuItem, Panel } from "@opencode/plugin/gui";
import { MemoryView } from "./view";

export const openMemoryId = "memory";

export function setup(ctx: SetupContext<never>): void {
  const text = (pt: string, en: string): string =>
    (ctx.locale.locale() ?? "").toLowerCase().startsWith("pt") ? pt : en;

  // The host reads the label per session switch; the memo follows the locale.
  const memoryTab = createMemo<PanelTab>(() => ({
    id: openMemoryId,
    title: text("Memória", "Memory"),
  }));

  const memoryPanel: PanelType = {
    id: openMemoryId,
    region: "side",
    list: () => [memoryTab()],
    render: () => <MemoryView />,
  };
  ctx.add(Panel, () => memoryPanel);

  ctx.add(Command, () => ({
    id: "open",
    title: text("Abrir Memória", "Open Memory"),
    description: text(
      "Abre a aba de Memória no painel lateral",
      "Opens the Memory tab in the side panel",
    ),
    bind: "mod+shift+m",
    group: "general",
    run: () => {
      const session = ctx.sessions.current();
      if (session) ctx.layout.open(`${ctx.id}:${openMemoryId}`, session);
    },
  }));

  ctx.add(MenuItem, (): SessionPanelMenuItem => ({
    menu: "session.panel",
    id: "memory",
    title: text("Memória", "Memory"),
    icon: "file-document",
    run: () => {
      const session = ctx.sessions.current();
      if (session) ctx.layout.open(`${ctx.id}:${openMemoryId}`, session);
    },
  }));
}
