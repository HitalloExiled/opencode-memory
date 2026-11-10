/**
 * Window-side registration for the Memory side panel.
 *
 * One side tab, opened from the command palette / keybind and from the
 * "+ / New tab" menu. The shared `registerSidePanel` keeps the shape the same
 * as the other panels: listed only while open, a mobile entry, "Recently
 * closed" support and locale-reactive labels.
 */

import type { SetupContext } from "@opencode/plugin/gui";
import { registerSidePanel } from "opencode-shared/gui";
import type { MemoryStores } from "./state";
import { MemoryView } from "./view";

export const openMemoryId = "memory";

type MemoryDeclarations = { stores: MemoryStores };

export function setup(ctx: SetupContext<MemoryDeclarations>): void {
  registerSidePanel(ctx, {
    id: openMemoryId,
    title: { pt: "Memória", en: "Memory" },
    icon: "brain",
    order: 40,
    bind: "mod+shift+m",
    command: {
      title: { pt: "Abrir Memória", en: "Open Memory" },
      description: {
        pt: "Abre a aba de Memória no painel lateral",
        en: "Opens the Memory tab in the side panel",
      },
    },
    view: ({ session }) => <MemoryView session={session} store={ctx.stores.view} />,
  });
}
