import * as path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/mainview",
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "src/mainview") },
      // electrobun/view resolves into the Hutch devkit (Electrobun 2's npm
      // package deliberately exports only an error).
      ...electrobunViteAliases(path.resolve(__dirname, ".hutch/devkit")),
    ],
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
