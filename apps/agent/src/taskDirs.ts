/** Per-task workspace cleanup, Claude session cleanup, and old task-folder pruning. */
import { lstat, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

/** Finished task folders keep their artifacts this long. */
const TASK_DIR_DAYS = 14;

/** The files of a run's folder that hold the engine token: Claude Code's MCP config. */
export async function removeTokenFiles(dir: string): Promise<void> {
  await rm(join(dir, ".scarlet", "mcp.json"), { force: true });
}

/** A finished task keeps only its artifacts. The CLI control files include the engine token. */
export async function removeControlFiles(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(entries.filter((name) => name !== "artifacts").map((name) => rm(join(dir, name), { recursive: true, force: true })));
  if (!entries.includes("artifacts")) await rm(dir, { recursive: true, force: true });
}

/** Where Claude Code keeps its files: CLAUDE_CONFIG_DIR when set, else ~/.claude. Undefined for a relative setting, read from each run's own folder. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  const set = env.CLAUDE_CONFIG_DIR;
  if (!set) return join(home, ".claude");
  return isAbsolute(set) ? set : undefined;
}

/** Claude Code names a cwd's project folder after its real path, every character other than a letter or digit as "-". */
function claudeProjectName(realCwd: string): string | undefined {
  const name = realCwd.replace(/[^a-zA-Z0-9]/g, "-");
  return /[a-zA-Z0-9]/.test(name) ? name : undefined;
}

/** Claude Code cuts a project folder's name at this many characters and adds a hash of the path to it. */
const CLAUDE_NAME_MAX = 200;

/**
 * Claude Code keeps a cwd's sessions in <its folder>/projects/<project name>. A name over 200 characters is cut there
 * and ends in a hash Scarlet can't reproduce: those are found by `claudeProjectDirs`.
 */
export function claudeProjectDir(realCwd: string, claudeDir = claudeConfigDir()): string | undefined {
  const name = claudeProjectName(realCwd);
  return !claudeDir || !name || name.length > CLAUDE_NAME_MAX ? undefined : join(claudeDir, "projects", name);
}

/**
 * The project folders holding a cwd's Claude sessions. A long path's folder is `<first 200 characters>-<hash>`, and
 * other task folders can share those characters, so one counts only where a session in it was run in this cwd.
 */
export async function claudeProjectDirs(realCwd: string, claudeDir = claudeConfigDir()): Promise<string[]> {
  const name = claudeProjectName(realCwd);
  if (!claudeDir || !name) return [];
  const isDir = async (dir: string) => (await lstat(dir).catch(() => undefined))?.isDirectory() === true;
  if (name.length <= CLAUDE_NAME_MAX) {
    const dir = join(claudeDir, "projects", name);
    return (await isDir(dir)) ? [dir] : [];
  }
  const prefix = `${name.slice(0, CLAUDE_NAME_MAX)}-`;
  const found: string[] = [];
  for (const entry of await readdir(join(claudeDir, "projects")).catch(() => [] as string[])) {
    if (!entry.startsWith(prefix) || !/^[0-9a-zA-Z]+$/.test(entry.slice(prefix.length))) continue;
    const dir = join(claudeDir, "projects", entry);
    if (await isDir(dir) && await sessionsRanIn(dir, realCwd)) found.push(dir);
  }
  return found;
}

/** Whether a session in this project folder records the cwd it ran in as this one. Each message line names it. */
async function sessionsRanIn(dir: string, realCwd: string): Promise<boolean> {
  for (const name of (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".jsonl")).slice(0, 5)) {
    const file = await open(join(dir, name), "r").catch(() => undefined);
    if (!file) continue;
    try {
      const { buffer, bytesRead } = await file.read({ buffer: Buffer.alloc(64 * 1024), position: 0 });
      for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
        let cwd: unknown;
        try {
          cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        } catch {
          continue;
        }
        if (typeof cwd === "string") return cwd === realCwd;
      }
    } finally {
      await file.close();
    }
  }
  return false;
}

/** A folder whose Claude sessions are Scarlet's to remove: a task folder, or a one-shot folder an older `scarlet-agent run` made. */
function scarletRunFolder(realCwd: string): boolean {
  return basename(dirname(realCwd)) === "tasks-v2" || basename(realCwd).startsWith("oneshot-");
}

/**
 * Delete the Claude sessions of one finished Scarlet task: only the project folder named after its task folder,
 * and the to-do list of each session in it.
 */
export async function removeClaudeSessions(realCwd: string, claudeDir = claudeConfigDir()): Promise<void> {
  if (!claudeDir || !scarletRunFolder(realCwd)) return;
  for (const dir of await claudeProjectDirs(realCwd, claudeDir)) {
    // Claude Code keeps a session's to-do list apart from it, in <its folder>/tasks/<session id>, and a session
    // is `<session id>.jsonl` here. Only a name of hex digits and dashes is read as an id: "...jsonl" would
    // name the folder itself. A list that can't be removed is left.
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const id = /^([0-9a-fA-F-]+)\.jsonl$/.exec(name)?.[1];
      const list = id && join(claudeDir, "tasks", id);
      if (list && (await lstat(list).catch(() => undefined))?.isDirectory()) await rm(list, { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/** Last use of a task folder: the folder, its artifacts folder or a file directly in it. */
async function lastUsed(dir: string): Promise<number | undefined> {
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) return undefined;
  const artifacts = join(dir, "artifacts");
  const files = await readdir(artifacts).catch(() => [] as string[]);
  const times = await Promise.all([artifacts, ...files.map((f) => join(artifacts, f))].map((p) => stat(p).then((s) => s.mtimeMs, () => 0)));
  return Math.max(info.mtimeMs, ...times);
}

/** Remove task folders unused for TASK_DIR_DAYS, including artifacts. Given where Claude Code keeps its files, a task folder's Claude sessions go with it. */
export async function pruneTaskDirs(workRoot: string, now = Date.now(), claudeDir?: string): Promise<void> {
  const cutoff = now - TASK_DIR_DAYS * 86_400_000;
  const dirs = [
    ...(await readdir(join(workRoot, "tasks-v2")).catch(() => [] as string[])).map((name) => join(workRoot, "tasks-v2", name)),
    ...(await readdir(workRoot).catch(() => [] as string[])).filter((name) => name.startsWith("oneshot-")).map((name) => join(workRoot, name)),
  ];
  await Promise.all(dirs.map(async (dir) => {
    const used = await lastUsed(dir);
    if (used === undefined || used >= cutoff) return;
    // A run that never finished left its Claude sessions behind. Resolve before the folder goes: its real path names them.
    const real = claudeDir === undefined ? undefined : await realpath(dir).catch(() => undefined);
    try {
      if (real) await removeClaudeSessions(real, claudeDir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }));
}
