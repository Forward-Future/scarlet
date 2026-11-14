/**
 * Agent CLIs an earlier launch left running. Each CLI runs in its own process group, so a host that crashes or is
 * killed signals nobody, and its CLIs keep working, and spending, with no host to report to. Each CLI is noted
 * while it runs, and the next launch stops those whose host is gone. Matches the desktop host.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { privateDirectory, windowsAclShell } from "./private-files.js";

const run = promisify(execFile);

/** Where each running CLI is noted, in a file named by its process id. Set by the launch sweep. */
let notes: { dir: string; log: (msg: string) => void } | undefined;

/** Stop the CLIs an earlier launch noted and left running, then note the CLIs this launch starts. Never throws. */
export async function stopOrphans(dir: string, log: (msg: string) => void): Promise<void> {
  notes = { dir, log };
  try {
    await privateDirectory(dir);
  } catch (err) {
    log(`could not prepare ${dir} for noting agent CLIs: ${errMsg(err)}`);
  }
  try {
    await stopNoted(dir, log);
  } catch (err) {
    log(`could not stop agent CLIs an earlier launch left running: ${errMsg(err)}`);
  }
}

async function stopNoted(dir: string, log: (msg: string) => void): Promise<void> {
  const names = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") log(`could not read the agent CLIs noted in ${dir}: ${errMsg(err)}`);
    return [] as string[];
  });
  for (const name of names) {
    const path = join(dir, name);
    const note = await readFile(path, "utf8").catch(() => "");
    // Process ids 0 and 1 name no CLI, and as a process group they would name this one or every process.
    const pid = /^[1-9]\d*$/.test(name) ? Number(name) : 0;
    // The desktop host writes a note in place, so one found empty under an id in use may be a note another Scarlet
    // is writing this moment. Removed now, its CLI could never be stopped. It goes once the id is free.
    if (!note.trim() && pid > 1 && idInUse(pid)) continue;
    const { cli, scarlet } = noteHalves(note);
    // The desktop app, a development preview and this host may share these notes. A CLI whose Scarlet is still
    // open is that Scarlet's work, and its note stays for the launch after that Scarlet's.
    if (scarlet && (await stillRuns(scarlet.pid, scarlet.note))) continue;
    if (pid > 1 && (await stillRuns(pid, cli))) {
      log(`stopping agent CLI ${pid} left running by an earlier session (${cli.split("\n")[0]})`);
      await killGroupNow(pid);
    }
    await rm(path, { force: true }).catch(() => undefined);
  }
}

/**
 * Note a CLI this launch has started, for the next launch to stop if this one crashes. The returned function
 * removes the note, once any note being written has landed. Notes nothing before the launch sweep has run.
 */
export function noteCli(pid: number, program: string): () => void {
  const at = notes;
  if (!at) return () => undefined;
  const path = join(at.dir, String(pid));
  const ended = new AbortController();
  const noted = noteFor(program, pid, ended.signal)
    .then((text) => (ended.signal.aborted ? undefined : publish(path, text)))
    // Without its note, the next launch can't stop this CLI if this one crashes.
    .catch((err) => void (ended.signal.aborted || at.log(`could not note agent CLI ${pid} for the next launch: ${errMsg(err)}`)));
  return () => {
    ended.abort();
    void noted.then(() => rm(path, { force: true })).catch(() => undefined);
  };
}

/**
 * Put a note under its name only once it is whole. A sweep, this host's or another Scarlet's, that read a note still
 * being written would take it for an empty one and remove it, and the CLI could then never be stopped. The note is
 * written beside the notes folder, in the work root no sweep reads, which is already private, so no note starts
 * PowerShell. Only a crash between the write and the rename leaves the written file there.
 */
async function publish(path: string, text: string): Promise<void> {
  const staged = join(dirname(dirname(path)), `.agent-pid-${randomUUID()}`);
  try {
    await writeFile(staged, text, { flag: "wx", mode: 0o600 });
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
}

/** What a note holds: the CLI's program and start time, then the process id, program and start time of the Scarlet that started it. */
export async function noteFor(program: string, pid: number, signal?: AbortSignal): Promise<string> {
  const [started, scarlet] = await Promise.all([startStamp(pid, signal), ownStart(signal)]);
  return `${program}\n${started}\n${process.pid}\n${process.execPath}\n${scarlet}`;
}

/** The CLI half of a note, and the Scarlet half when the note has one. */
function noteHalves(note: string): { cli: string; scarlet?: { pid: number; note: string } } {
  const lines = note.split("\n").map((line) => line.replace(/\r$/, ""));
  const pair = (at: number) => lines.slice(at, at + 2).join("\n");
  const owner = lines[2]?.trim() ?? "";
  return { cli: pair(0), scarlet: /^\d+$/.test(owner) ? { pid: Number(owner), note: pair(3) } : undefined };
}

let ownStartRead: string | undefined;

/**
 * When this Scarlet started, as its notes record it. Windows counts a start time the same way for as long as the
 * process lives, and reading one starts PowerShell, so it is read once there. `ps` prints a start time in the time
 * zone of the moment, so elsewhere it is read for each note, beside the CLI's.
 */
async function ownStart(signal?: AbortSignal): Promise<string> {
  if (process.platform !== "win32") return startStamp(process.pid, signal);
  if (ownStartRead) return ownStartRead;
  const read = await startStamp(process.pid, signal);
  if (read) ownStartRead = read;
  return read;
}

/** When the process started: as `ps` prints it, or on Windows as the file time .NET gives. Empty when it is gone or can't be read. */
export async function startStamp(pid: number, signal?: AbortSignal): Promise<string> {
  try {
    if (process.platform !== "win32") return (await run("ps", ["-o", "lstart=", "-p", String(pid)], { signal })).stdout.trim();
    const script = `try { [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc() } catch { }`;
    const shell = windowsAclShell();
    return (await run(shell.executable, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, env: shell.env, signal })).stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Whether the process with this id is the one a note names. The id may have been given to another program since,
 * so a note stops nothing unless the process has the noted program and the noted start time now. A note without a
 * start time names nothing: the program alone would also fit an unrelated process that has since had the id.
 */
async function stillRuns(pid: number, note: string): Promise<boolean> {
  const [program = "", started = ""] = note.split("\n");
  const name = basename(program.trim());
  if (!name || !started.trim() || (await startStamp(pid)) !== started.trim()) return false;
  return runsProgram(pid, name);
}

/** Whether any process has the id now. One this user may not signal still has it. */
function idInUse(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether the process runs the program: by the command line `ps` prints for it, or the image `tasklist` names on Windows, where file names ignore case. */
async function runsProgram(pid: number, name: string): Promise<boolean> {
  try {
    if (process.platform !== "win32") return (await run("ps", ["-o", "command=", "-p", String(pid)])).stdout.includes(name);
    const tasklist = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe");
    const { stdout } = await run(tasklist, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true });
    return stdout.toLowerCase().includes(name.toLowerCase());
  } catch {
    return false;
  }
}

/** Kill the CLI's whole process group at once. Windows: `taskkill /T /F`. */
async function killGroupNow(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    await run(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      /* already gone, or not a group leader */
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
