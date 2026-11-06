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
import type { MemoryStores } from "./state";
import { MemoryView } from "./view";

export const openMemoryId = "memory";

type MemoryDeclarations = { stores: MemoryStores };

export function setup(ctx: SetupContext<MemoryDeclarations>): void {
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
    render: (props) => <MemoryView session={props.session} store={ctx.stores.view} />,
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
    // Native panel actions use orders 10-30; plugin tabs go after them.
    order: 42,
    title: text("Memória", "Memory"),
    icon: "file-document",
    run: () => {
      const session = ctx.sessions.current();
      if (session) ctx.layout.open(`${ctx.id}:${openMemoryId}`, session);
    },
  }));
}
