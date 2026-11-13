// Build and QA scripts opt into the development storage inventory. Registration
// grants visibility only. Scarlet never deletes files from these external roots.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function registerStorage(kind, directory) {
  if (!["cargo", "scratch"].includes(kind) || !directory) throw new Error("Expected cargo or scratch and an existing directory");
  const path = realpathSync(directory);
  if (dirname(path) === path || [homedir(), tmpdir()].some(base => realpathSync(base) === path)) throw new Error("Choose a dedicated build or test directory");
  const home = homedir();
  const cache = process.platform === "darwin" ? join(home, "Library", "Caches")
    : process.platform === "win32" ? process.env.LOCALAPPDATA : process.env.XDG_CACHE_HOME || join(home, ".cache");
  const registry = join(cache, "com.forwardfuture.scarlet.development", "storage");
  mkdirSync(registry, { recursive: true, mode: 0o700 });
  const id = createHash("sha256").update(kind + "\0" + path).digest("hex");
  const entry = join(registry, id + ".json");
  const temp = entry + "." + randomUUID();
  try {
    writeFileSync(temp, JSON.stringify({ kind, path }), { mode: 0o600 });
    renameSync(temp, entry);
  } finally { rmSync(temp, { force: true }); }
  return () => rmSync(entry, { force: true });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  registerStorage(process.argv[2], process.argv[3]);
}
