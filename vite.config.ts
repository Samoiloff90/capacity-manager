import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * write-excel-file imports fflate's asynchronous zip, which compresses large entries in a
 * blob: Web Worker that the application CSP forbids. Only the bare "fflate" import is
 * redirected; the shim itself imports "fflate/browser". After editing the shim run
 * `vite --force`: the dev pre-bundle cache does not track its content.
 */
export const fflateSyncZipAlias = {
  find: /^fflate$/,
  replacement: fileURLToPath(new URL("./src/export/fflate-sync-zip.ts", import.meta.url))
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias: [fflateSyncZipAlias] },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true
  },
  envPrefix: ["VITE_", "TAURI_"]
});
