// Builds the Scarlet engine as a single self-contained executable using Node's
// Single Executable Application support:
//   1. esbuild bundles dist/cli.js (+ all workspace deps) into one CommonJS file
//   2. `node --experimental-sea-config` turns it into a blob
//   3. postject injects the blob into a copy of the running node binary
//
// Usage: node scripts/build-sea.mjs [--out <path>]   (default build/scarlet-engine[.exe])
// Requires `pnpm build` to have run first (dist/ of every workspace package).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundleSpeakerRuntime } from "./bundle-speaker-runtime.mjs";
import { bundleUhmRuntime } from "./bundle-uhm-runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const outArg = args[args.indexOf("--out") + 1];
const isWin = process.platform === "win32";
const outPath = resolve(outArg && args.includes("--out") ? outArg : resolve(pkgDir, `build/scarlet-engine${isWin ? ".exe" : ""}`));
const buildDir = resolve(pkgDir, "build/sea");
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
mkdirSync(dirname(outPath), { recursive: true });

const entry = resolve(pkgDir, "dist/cli.js");
if (!existsSync(entry)) {
  console.error("dist/cli.js missing — run `pnpm -r build` first");
  process.exit(1);
}

// 1. Bundle. `import.meta.url` is rewritten to the executable's own URL so the
// few places that use it (seed-dir lookup) behave sensibly inside the SEA.
const bundle = resolve(buildDir, "engine.cjs");
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: bundle,
  sourcemap: false,
  minify: true,
  keepNames: true,
  legalComments: "none",
  logLevel: "warning",
  define: { "import.meta.url": "__scarlet_import_meta_url" },
  banner: {
    js: `const __scarlet_import_meta_url = require("node:url").pathToFileURL(process.execPath).href;`,
  },
  external: ["node:sqlite", "bufferutil", "utf-8-validate"],
});
console.log(`[sea] bundled -> ${bundle} (${(statSync(bundle).size / 1024 / 1024).toFixed(1)} MB)`);

await bundleUhmRuntime(resolve(dirname(outPath), "uhm-runtime"));
bundleSpeakerRuntime(resolve(dirname(outPath), "speaker-runtime"));

// 2. Blob.
const seaConfig = resolve(buildDir, "sea-config.json");
const blob = resolve(buildDir, "engine.blob");
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: true }, null, 2),
);
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

// 3. Inject into a copy of node.
copyFileSync(process.execPath, outPath);
if (!isWin) chmodSync(outPath, 0o755);
if (process.platform === "darwin") {
  // Remove the signature before injecting; re-sign (ad hoc) afterwards.
  try {
    execFileSync("codesign", ["--remove-signature", outPath], { stdio: "inherit" });
  } catch {
    /* best effort */
  }
}
const postject = require.resolve("postject/dist/cli.js");
const postjectArgs = [postject, outPath, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
if (process.platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
execFileSync(process.execPath, postjectArgs, { stdio: "inherit" });
if (process.platform === "darwin") {
  try {
    execFileSync("codesign", ["--sign", "-", outPath], { stdio: "inherit" });
  } catch {
    /* best effort */
  }
}
console.log(`[sea] engine -> ${outPath} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`);
