import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { spawnSync } from "node:child_process";
import desktopConfig from "../desktop/src-tauri/tauri.conf.json";

const revision = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8", windowsHide: true });

export default defineConfig(({ command, mode }) => ({
  // The public video and frame belong to the isolated native interview demo.
  publicDir: command === "serve" && mode === "desktop-demo" ? process.env.SCARLET_DEMO_MEDIA_DIR || "public" : false,
  define: {
    __SCARLET_VERSION__: JSON.stringify(desktopConfig.version),
    __SCARLET_REVISION__: JSON.stringify(revision.status === 0 ? revision.stdout.trim() : ""),
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: "node",
    setupFiles: ["src/lib/domTestSetup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
