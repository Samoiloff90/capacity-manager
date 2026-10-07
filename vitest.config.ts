import { defineConfig } from "vitest/config";
import { fflateSyncZipAlias } from "./vite.config";

// Reports show local time; recorded fixtures were made in Moscow time. CI runs in UTC, so
// the test processes (forked from here) get the same zone everywhere.
process.env.TZ = "Europe/Moscow";

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
