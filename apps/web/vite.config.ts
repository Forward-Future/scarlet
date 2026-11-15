import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { spawnSync } from "node:child_process";
import desktopConfig from "../desktop/src-tauri/tauri.conf.json";

const revision = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8", windowsHide: true });
const releaseChannel = process.env.SCARLET_RELEASE_CHANNEL;
if (releaseChannel && !["stable", "early-access", "linux-preview"].includes(releaseChannel)) {
  throw new Error(`Unknown Scarlet release channel: ${releaseChannel}`);
}

export default defineConfig(({ command, mode }) => ({
  // The public video and frame belong to the isolated native interview demo.
  publicDir: command === "serve" && mode === "desktop-demo" ? process.env.SCARLET_DEMO_MEDIA_DIR || "public" : false,
  define: {
    __SCARLET_VERSION__: JSON.stringify(desktopConfig.version),
    __SCARLET_RELEASE_CHANNEL__: JSON.stringify(releaseChannel || null),
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
    // The native player layout test measures the same compiled styles as the desktop renderer.
    css: { include: [/\.css\?inline$/] },
    environment: "node",
    setupFiles: ["src/lib/domTestSetup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // SimpleWorkspace.test.tsx is one long file that would hold a full run on one worker for minutes. A full run
    // spreads it over its part files instead; named on the command line, it runs whole on its own.
    exclude: [...configDefaults.exclude, ...(process.argv.some(arg => arg.includes("SimpleWorkspace.test"))
      ? ["src/pages/SimpleWorkspace.part*.test.tsx"] : ["src/pages/SimpleWorkspace.test.tsx"])],
  },
}));
