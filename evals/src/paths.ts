/** Where eval data lives. Real cases and results never go inside the repository. */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Scarlet's application support folder (the engine keeps its data, token and database under data/). */
export function appSupportDir(): string {
  if (process.env.SCARLET_APP_SUPPORT) return process.env.SCARLET_APP_SUPPORT;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "com.forwardfuture.scarlet");
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "com.forwardfuture.scarlet");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "com.forwardfuture.scarlet");
}

/** SCARLET_EVAL_DATA, else <application support>/evals. */
export function dataDir(): string {
  return resolve(process.env.SCARLET_EVAL_DATA ?? join(appSupportDir(), "evals"));
}

export const casesDir = () => join(dataDir(), "cases");
export const caseDir = (id: string) => checkedPath(dataDir(), join(casesDir(), fileComponent(id)));
export const resultsDir = () => join(dataDir(), "results");
export const cacheDir = () => join(dataDir(), "cache");

/** A portable single filename, including user-named cases. */
export function fileComponent(id: string): string {
  if (typeof id !== "string" || !id || id === "." || /[. ]$/.test(id) ||
      /[<>:"/\\|?*\u0000-\u001f]/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)) {
    throw new Error("Invalid evaluation filename component");
  }
  return id;
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

/** The operator chooses the root. A supplied case must not introduce linked directories or files below it. */
export function checkedPath(root: string, path: string): string {
  const base = resolve(root), dest = resolve(path);
  if (!isWithin(base, dest)) throw new Error("Evaluation path leaves the selected directory");
  for (let p = dest; ; p = dirname(p)) {
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Linked evaluation path");
    if (p === base) break;
  }
  return dest;
}

export function writeJson(path: string, value: unknown, root = dataDir()) {
  writeText(path, JSON.stringify(value, null, 1) + "\n", root);
}

export function writeText(path: string, text: string, root = dataDir()) {
  const dest = checkedPath(root, path);
  let ancestor = dirname(dest);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const physical = resolve(realpathSync(ancestor), relative(ancestor, dest));
  if (isWithin(REPO_ROOT, dest) || isWithin(realpathSync(REPO_ROOT), physical)) throw new Error("Refusing to write eval data inside the repository");
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(dest), "." + basename(dest) + "." + randomUUID());
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try { writeFileSync(fd, text); } finally { closeSync(fd); }
    renameSync(tmp, dest);
  } finally { rmSync(tmp, { force: true }); }
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function timestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
}
