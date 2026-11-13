// Reproduce build-sea.mjs's blob and injection on the target Windows Node release.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const [main, exe, postjectApi] = process.argv.slice(2);
assert(process.platform === "win32" && process.versions.node.startsWith("24."));
const dir = mkdtempSync(join(tmpdir(), "scarlet-sea-"));
try {
  const output = join(dir, "engine.blob"), config = join(dir, "sea-config.json");
  writeFileSync(config, JSON.stringify({main, output, disableExperimentalSEAWarning:true, useCodeCache:true}));
  execFileSync(process.execPath, ["--experimental-sea-config", config], {stdio:"inherit"});
  copyFileSync(process.execPath, exe, constants.COPYFILE_EXCL);
  const { inject } = createRequire(import.meta.url)(postjectApi);
  await inject(exe, "NODE_SEA_BLOB", readFileSync(output), { sentinelFuse:"NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2" });
} finally { rmSync(dir, { recursive:true, force:true }); }
