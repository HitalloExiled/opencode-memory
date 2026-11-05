/**
 * Window-side registration for the Memory side panel.
 *
 * Registers a removable "Memória" tab in the session's side region, a command
 * palette / keybind entry, and a "+ / New tab" menu entry.
 */

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
  const memoryTab: PanelTab = {
    id: openMemoryId,
    title: "Memória",
  };

  const memoryPanel: PanelType = {
    id: openMemoryId,
    region: "side",
    list: () => [memoryTab],
    render: () => <MemoryView />,
  };
  ctx.add(Panel, () => memoryPanel);

  ctx.add(Command, () => ({
    id: "open",
    title: "Abrir Memória",
    description: "Abre a aba de Memória no painel lateral",
    bind: "mod+shift+m",
    group: "general",
    run: () => {
      const session = ctx.sessions.current();
      if (session) ctx.layout.open(`${ctx.id}:${openMemoryId}`, session);
    },
  }));

  const memoryMenu: SessionPanelMenuItem = {
    menu: "session.panel",
    id: "memory",
    title: "Memória",
    icon: "file-document",
    run: () => {
      const session = ctx.sessions.current();
      if (session) ctx.layout.open(`${ctx.id}:${openMemoryId}`, session);
    },
  };
  ctx.add(MenuItem, () => memoryMenu);
}
