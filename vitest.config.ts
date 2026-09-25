import { defineConfig } from "vitest/config";
import { fflateSyncZipAlias } from "./vite.config";

export default defineConfig({
  resolve: { alias: [fflateSyncZipAlias] },
  test: {
    environment: "node",
    globals: true,
    // Externalized packages skip Vite's resolver; inline write-excel-file so its
    // "fflate" import goes through the same worker-free alias as the app build.
    server: { deps: { inline: ["write-excel-file"] } }
  }
});
