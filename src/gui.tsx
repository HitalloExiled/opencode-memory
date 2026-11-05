/**
 * Memory GUI — the `./gui-experimental` entry.
 *
 * The panel reads the derived index and session timelines through the server
 * plugin's RPC (`MemoryRpc`), so the same hot-reloaded server process owns
 * `index.db` and serves the window.
 */

import { Plugin } from "@opencode/plugin/gui";
import { setup } from "./gui/setup";

const definition = Plugin.define({
  stores: {},
  setup,
});

export default definition;
export type Definition = typeof definition;
