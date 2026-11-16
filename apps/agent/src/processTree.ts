import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/** Stop a CLI and its subprocesses. On POSIX it must have been started in its own group with detached: true. */
export function stopCliTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode) return;
    const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* process group already gone */
  }
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
