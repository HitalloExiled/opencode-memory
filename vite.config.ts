import { gui } from "@opencode/plugin/gui/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    gui({
      entry: "src/gui.tsx",
      outFile: "dist/gui-experimental.cjs",
    }),
  ],
  build: {
    rollupOptions: { output: { exports: "named", inlineDynamicImports: true } },
  },
});
