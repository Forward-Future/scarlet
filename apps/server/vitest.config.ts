import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// The shipped skills and the record of retired ones are compiled from skills/ (src/bundledSkills.ts, not in git). Build
// them before any test, so a checkout that hasn't run a full build never tests against an old copy.
execFileSync(process.execPath, [fileURLToPath(new URL("./scripts/gen-skills.mjs", import.meta.url))], { stdio: "ignore" });

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
