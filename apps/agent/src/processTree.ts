import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { privateDirectory } from "./private-files.js";

/**
 * How long a CLI told to stop has to finish before its whole process group is killed. Claude Code writes its session
 * as it stops, and the attempt that resumes the run (`--resume`) carries on from it. Matches the desktop host.
 */
export const KILL_AFTER_MS = 5000;

/** CLIs told to stop in this launch, and when. For a few seconds after a stop, members of a CLI's group may still be alive. */
const stopping = new Map<number, number>();

/**
 * Stop a CLI and its subprocesses. On POSIX it must have been started in its own group with detached: true: the group
 * is asked to stop (SIGTERM), then killed `killAfterMs` later, whatever is left of it. Windows has nothing to finish:
 * `taskkill /T /F` ends the whole tree at once.
 */
export function stopCliTree(child: ChildProcess, killAfterMs = KILL_AFTER_MS): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode) return;
    const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
    return;
  }
  const pid = child.pid;
  signalGroup(pid, "SIGTERM", child);
  stopping.set(pid, Date.now());
  setTimeout(() => {
    if (stopping.get(pid) === undefined) return;
    stopping.delete(pid);
    signalGroup(pid, "SIGKILL", child);
  }, killAfterMs).unref();
}

/** Kill a CLI's whole group at once, on POSIX: for a straggler still there after the polite stop and its kill. */
export function killCliTree(child: ChildProcess): void {
  if (!child.pid || process.platform === "win32") return;
  stopping.delete(child.pid);
  signalGroup(child.pid, "SIGKILL", child);
}

function signalGroup(pid: number, signal: NodeJS.Signals, child?: Pick<ChildProcess, "exitCode" | "signalCode">): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* process group already gone */
  }
  // The CLI itself, should it have left its group. Not once it has exited: the system may give its id to another program.
  if (child && (child.exitCode !== null || child.signalCode !== null)) return;
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * At exit, finish off the CLIs this launch has just told to stop: the kill that follows a polite stop five seconds
 * later doesn't go out once the host has exited. Windows stops a CLI's whole tree at once, so nothing is left there.
 */
export function killStoppedNow(now = Date.now()): void {
  const stopped = [...stopping];
  stopping.clear();
  if (process.platform === "win32") return;
  for (const [pid, at] of stopped) if (now - at < KILL_AFTER_MS) signalGroup(pid, "SIGKILL");
}

/**
 * What a second stop, sent a moment after the first, should do. On POSIX the group outlives its leader, so sending the
 * kill again reaches a straggler. On Windows `taskkill /T` walks the tree from the CLI's own pid: once the first stop has
 * killed the CLI, that walk finds nothing, and a process it started that still holds the output open would keep the run
 * going for good. There the only thing left to do is stop waiting on that output.
 */
export function repeatStop(child: Pick<ChildProcess, "exitCode" | "signalCode">, platform: NodeJS.Platform = process.platform): "kill-tree" | "release-output" {
  return platform === "win32" && (child.exitCode !== null || child.signalCode !== null) ? "release-output" : "kill-tree";
}

// -- CLIs an earlier launch left running --------------------------------------

/** Where each running agent CLI's process id is noted, so the next launch can stop one this launch never got to. */
let pidDir: string | undefined;

const run = promisify(execFile);

/** When the process started, as `ps` prints it. Empty when it is gone or can't be read. */
async function startStamp(pid: number): Promise<string> {
  if (process.platform === "win32") return "";
  try {
    return (await run("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5000 })).stdout.trim();
  } catch {
    return "";
  }
}

/** Whether the process is running the program, by the command line `ps` prints for it. */
async function runsProgram(pid: number, name: string): Promise<boolean> {
  try {
    return (await run("ps", ["-o", "command=", "-p", String(pid)], { timeout: 5000 })).stdout.includes(name);
  } catch {
    return false;
  }
}

/**
 * Whether the process noted at spawn, by program and start time, still runs: a freed process id sooner or later
 * belongs to another program. A note without a start time stops nothing, since the name alone would fit any process
 * given the id since.
 */
export async function stillRuns(pid: number, note: string): Promise<boolean> {
  const [program = "", started = ""] = note.split("\n");
  const name = basename(program.trim());
  if (!name || !started.trim()) return false;
  return (await startStamp(pid)) === started.trim() && runsProgram(pid, name);
}

/** What a note holds: the CLI's program and start time, then the process id, program and start time of the host that started it. */
function noteHalves(note: string): { cli: string; host?: { pid: number; note: string } } {
  const lines = note.split("\n");
  const pid = Number(lines[2]?.trim());
  return { cli: lines.slice(0, 2).join("\n"), ...(Number.isInteger(pid) && pid > 0 && { host: { pid, note: lines.slice(3, 5).join("\n") } }) };
}

/**
 * Stop agent CLIs an earlier launch left running. A crash or a force quit signals nobody: each CLI runs in its own
 * process group and would keep working, and spending, with no host to report to. A CLI whose host is still open (another
 * `scarlet-agent start` on the same folder) is that host's work, and its note stays. The desktop host does the same.
 */
export async function stopOrphans(dir: string, log: (msg: string) => void = () => undefined): Promise<void> {
  // Windows reads no start time here, so a note there could stop nothing safely.
  if (process.platform === "win32") return;
  await privateDirectory(dir);
  pidDir = dir;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name);
    const { cli, host } = noteHalves(await readFile(path, "utf8").catch(() => ""));
    if (host && await stillRuns(host.pid, host.note)) continue;
    const pid = Number(name);
    if (Number.isInteger(pid) && pid > 0 && await stillRuns(pid, cli)) {
      log(`stopping agent CLI ${pid} left running by an earlier launch (${cli.split("\n")[0]})`);
      signalGroup(pid, "SIGKILL");
    }
    await rm(path, { force: true });
  }
}

/** Note a CLI just started, for the next launch. Nothing once no folder was set (`stopOrphans`). */
export async function noteCli(pid: number, program: string): Promise<void> {
  const dir = pidDir;
  if (!dir || process.platform === "win32") return;
  const [cli, host] = await Promise.all([startStamp(pid), startStamp(process.pid)]);
  // A CLI already gone has no start time, and nothing to stop.
  if (!cli) return;
  await writeFile(join(dir, String(pid)), `${program}\n${cli}\n${process.pid}\n${process.execPath}\n${host}`, { mode: 0o600 });
}

/** The CLI has ended: its note goes. */
export async function forgetCli(pid: number): Promise<void> {
  if (pidDir) await rm(join(pidDir, String(pid)), { force: true });
}
