import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { noteCli, noteFor, startStamp, stopOrphans } from "./orphans.js";
import { spawnLines } from "./runners/spawn.js";

/** A note write a test holds open, as `writeFile` leaves one between creating the file and writing to it. */
const held = vi.hoisted(() => ({ next: undefined as undefined | { opened: () => void; release: Promise<void> } }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const writeFile: typeof fs.writeFile = async (file, data, options) => {
    const hold = held.next;
    if (!hold || typeof file !== "string" || typeof data !== "string") return fs.writeFile(file, data, options);
    held.next = undefined;
    const { flag = "w", mode = 0o666 } = typeof options === "object" && options ? options : {};
    const handle = await fs.open(file, flag, mode);
    try {
      hold.opened();
      await hold.release;
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
  };
  return { ...fs, writeFile };
});

async function noteDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-orphans-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "agent-pids"));
  return join(dir, "agent-pids");
}

/**
 * A process that stays up until it is killed, as a stand-in for a CLI or for another Scarlet. It starts in its own
 * process group, as a CLI does, and is stopped by its own id when the test ends.
 */
function idler(args = ["-e", "setTimeout(() => {}, 120000)"]) {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true });
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  const running = () => child.exitCode === null && child.signalCode === null;
  onTestFinished(async () => {
    if (!running()) return;
    child.kill();
    await exited;
  });
  return { pid: child.pid!, stdout: child.stdout, exited, running, stop: async () => void (child.kill(), await exited) };
}

/**
 * A stand-in CLI with a tool subprocess under it, in its process group on POSIX and in its tree on Windows. The
 * subprocess is stopped by its own id when the test ends, unless that id has since gone to another process.
 */
async function idlerWithTool() {
  const script = "const t = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true }); console.log(t.pid); setTimeout(() => {}, 120000)";
  const cli = idler(["-e", script]);
  const [line] = (await once(cli.stdout!, "data")) as [Buffer];
  const pid = Number(String(line).trim());
  const started = await startStamp(pid);
  onTestFinished(async () => {
    if (started && (await startStamp(pid)) === started) process.kill(pid, "SIGTERM");
  });
  const running = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return { ...cli, tool: { pid, running } };
}

/** What a note says of a process: this Node, and when the process started. */
async function stamped(pid: number): Promise<string> {
  return `${process.execPath}\n${await startStamp(pid)}`;
}

function logged() {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line) };
}

// Windows starts PowerShell to read each start time.
describe("stopOrphans", { timeout: 30_000 }, () => {
  it("stops a CLI an earlier host noted once that host is gone, its whole group at once, and removes the note", async () => {
    const dir = await noteDir();
    const earlier = idler();
    const host = `${earlier.pid}\n${await stamped(earlier.pid)}`;
    await earlier.stop();
    const cli = await idlerWithTool();
    const older = idler();
    await writeFile(join(dir, String(cli.pid)), `${await stamped(cli.pid)}\n${host}`);
    // A note from before the host recorded itself names only the CLI. Nobody is left to ask, so it is stopped too.
    await writeFile(join(dir, String(older.pid)), await stamped(older.pid));
    const { lines, log } = logged();
    await stopOrphans(dir, log);
    // Killed, not left to run out.
    expect((await cli.exited)[0]).not.toBe(0);
    expect((await older.exited)[0]).not.toBe(0);
    // Its tool subprocess too, not the CLI alone.
    await vi.waitFor(() => expect(cli.tool.running()).toBe(false), { timeout: 10_000 });
    expect(await readdir(dir)).toEqual([]);
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining(`stopping agent CLI ${cli.pid} `), expect.stringContaining(`stopping agent CLI ${older.pid} `)]));
  });

  it("stops nothing under an id now held by another program or a later process, or for a note that names no start time", async () => {
    const dir = await noteDir();
    const [program, restarted, unstamped, empty] = [idler(), idler(), idler(), idler()];
    // The id is the noted process's, as is the start time, but another program runs under it.
    await writeFile(join(dir, String(program.pid)), `/usr/local/bin/claude\n${await startStamp(program.pid)}`);
    // The noted program runs under the id, but it started at another time.
    await writeFile(join(dir, String(restarted.pid)), `${process.execPath}\nMon Jan  1 00:00:00 2001`);
    // The program alone would fit an unrelated process that has since had the id.
    await writeFile(join(dir, String(unstamped.pid)), `${process.execPath}\n`);
    await writeFile(join(dir, String(empty.pid)), "");
    // A file not named by a process id is no note, whatever it says.
    await writeFile(join(dir, "README"), await stamped(empty.pid));
    await writeFile(join(dir, `${empty.pid}.old`), await stamped(empty.pid));
    const { lines, log } = logged();
    await stopOrphans(dir, log);
    await delay(300);
    for (const p of [program, restarted, unstamped, empty]) expect(p.running()).toBe(true);
    expect(lines).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("leaves a CLI whose Scarlet is still open, this host or another, and stops it once that Scarlet has gone", async () => {
    const dir = await noteDir();
    const [ours, kept, app] = [idler(), idler(), idler()];
    // One is this process's, noted as a spawn notes it. The other belongs to another Scarlet that is still open.
    await writeFile(join(dir, String(ours.pid)), await noteFor(process.execPath, ours.pid));
    await writeFile(join(dir, String(kept.pid)), `${await stamped(kept.pid)}\n${app.pid}\n${await stamped(app.pid)}`);
    await stopOrphans(dir, () => undefined);
    await delay(300);
    expect([ours.running(), kept.running(), app.running()]).toEqual([true, true, true]);
    expect((await readdir(dir)).sort()).toEqual([String(ours.pid), String(kept.pid)].sort());
    await app.stop();
    await stopOrphans(dir, () => undefined);
    expect((await kept.exited)[0]).not.toBe(0);
    expect(ours.running()).toBe(true);
    expect(await readdir(dir)).toEqual([String(ours.pid)]);
  });

  it("never shows a sweep a note still being written, and puts the note in place whole once it is", async () => {
    const dir = await noteDir();
    await stopOrphans(dir, () => undefined);
    const cli = idler();
    // The note's file is created and held there before anything is written to it.
    let opened!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (opened = resolve));
    held.next = { opened, release: new Promise<void>((resolve) => (release = resolve)) };
    const forget = noteCli(cli.pid, process.execPath);
    onTestFinished(forget);
    await reached;
    // Another Scarlet's launch sweeps the shared notes meanwhile.
    const seen = await readdir(dir);
    const { lines, log } = logged();
    await stopOrphans(dir, log);
    release();
    const expected = await noteFor(process.execPath, cli.pid);
    await vi.waitFor(async () => expect(await readFile(join(dir, String(cli.pid)), "utf8").catch(() => "")).toBe(expected), { timeout: 5_000 });
    expect(seen).toEqual([]);
    expect(lines).toEqual([]);
    expect(cli.running()).toBe(true);
    // Nothing is left where the note was written.
    expect(await readdir(join(dir, ".."))).toEqual(["agent-pids"]);
  });

  it("logs and carries on when the notes can't be read, so the host still starts", async () => {
    const dir = await noteDir();
    await writeFile(join(dir, "file"), "");
    const { lines, log } = logged();
    await expect(stopOrphans(join(dir, "file", "agent-pids"), log)).resolves.toBeUndefined();
    expect(lines[0]).toMatch(/^could not prepare .* for noting agent CLIs: /);
  });

  it("notes a CLI while it runs, only after handing it its prompt, and removes the note when it ends", async () => {
    const dir = await noteDir();
    await stopOrphans(dir, () => undefined);
    const lines: string[] = [];
    const cli = spawnLines(process.execPath, ["-e", "process.stdin.on('data', d => console.log(String(d))); setTimeout(() => {}, 120000)"], {
      cwd: dir, env: process.env, stdin: "the prompt", onLine: (line) => lines.push(line),
    });
    onTestFinished(() => cli.kill());
    const note = join(dir, String(cli.child.pid));
    // Handed over before any start time is read: Claude Code waits only a few seconds for its prompt.
    expect(cli.child.stdin!.writableEnded).toBe(true);
    expect(existsSync(note)).toBe(false);
    await vi.waitFor(() => expect(lines).toEqual(["the prompt"]));
    // The CLI, then the host that started it, each as the next launch recognises a process.
    const expected = await noteFor(process.execPath, cli.child.pid!);
    expect(expected.split("\n")).toHaveLength(5);
    await vi.waitFor(async () => expect(await readFile(note, "utf8").catch(() => "")).toBe(expected), { timeout: 15_000 });
    cli.kill();
    await cli.done;
    await vi.waitFor(() => expect(existsSync(note)).toBe(false));
    // A CLI that has ended before its start time is read leaves no note behind.
    await spawnLines(process.execPath, ["-e", ""], { cwd: dir, env: process.env, onLine: () => undefined }).done;
    await delay(1000);
    expect(await readdir(dir)).toEqual([]);
  });
});
