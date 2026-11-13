import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Scoped to evals/ so package test runs (each `vitest run` inside packages/* or apps/*) never pick these up.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["test/**/*.test.ts"],
  },
});
