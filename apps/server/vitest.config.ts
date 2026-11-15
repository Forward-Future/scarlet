import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // workspace.test.ts is one long file that would hold a full run on one worker. A full run spreads it over its
    // part files instead; named on the command line, it runs whole on its own.
    exclude: [...configDefaults.exclude, ...(process.argv.some(arg => arg.includes("workspace.test"))
      ? ["src/workspace.part*.test.ts"] : ["src/workspace.test.ts"])],
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
