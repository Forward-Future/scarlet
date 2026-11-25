/**
 * Incremental tailer for `agy`'s per-session `transcript.jsonl`, reporting live token usage mid-turn while
 * `session/prompt` is in flight.
 */
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentUsage } from "@scarlet/shared";
import { jsonLine } from "./spawn.js";
import { addUsage, geminiTranscriptStepUsage } from "./usage.js";

/**
 * Path to `agy`'s per-session `transcript.jsonl`, where completed planner steps are written mid-turn: in the run's own
 * Gemini folder (`--gemini-dir`), or the user's `~/.gemini` when the run has none.
 */
function agyTranscriptPath(env: Record<string, string | undefined>, geminiDir: string | undefined, sessionId: string): string | undefined {
  if (!sessionId || /[/\\]|\.\./.test(sessionId)) return undefined;
  const home = env.HOME || env.USERPROFILE || homedir();
  const dir = geminiDir ?? (home ? join(home, ".gemini") : undefined);
  if (!dir) return undefined;
  return join(dir, "antigravity-cli", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
}

export class TranscriptUsageTailer {
  private path: string | undefined;
  private offset = 0;
  private seenSteps = new Set<number>();
  private turnUsage: AgentUsage | undefined;

  open(env: Record<string, string | undefined>, geminiDir: string | undefined, sessionId: string, skipExisting: boolean) {
    this.path = agyTranscriptPath(env, geminiDir, sessionId);
    this.offset = 0;
    if (skipExisting && this.path) {
      try {
        this.offset = statSync(this.path).size;
      } catch {
        this.offset = 0;
      }
    }
    this.seenSteps.clear();
    this.turnUsage = undefined;
  }

  poll(model: string | undefined): AgentUsage | undefined {
    if (!this.path) return this.turnUsage;
    let fd: number | undefined;
    try {
      fd = openSync(this.path, "r");
      const size = fstatSync(fd).size;
      if (size <= this.offset) return this.turnUsage;
      const toRead = size - this.offset;
      const buf = Buffer.allocUnsafe(toRead);
      let read = 0;
      while (read < toRead) {
        const n = readSync(fd, buf, read, toRead - read, this.offset + read);
        if (n <= 0) break;
        read += n;
      }
      if (read <= 0) return this.turnUsage;
      const slice = buf.subarray(0, read);
      const lastNl = slice.lastIndexOf(0x0a);
      if (lastNl < 0) return this.turnUsage;
      this.offset += lastNl + 1;
      const text = slice.subarray(0, lastNl + 1).toString("utf8");
      for (const line of text.split("\n")) {
        if (!line) continue;
        const val = jsonLine(line);
        if (!val) continue;
        const stepUsage = geminiTranscriptStepUsage(val, model);
        if (!stepUsage) continue;
        if (typeof val.step_index === "number" && Number.isFinite(val.step_index)) {
          if (this.seenSteps.has(val.step_index)) continue;
          this.seenSteps.add(val.step_index);
        }
        this.turnUsage = addUsage(this.turnUsage, stepUsage);
      }
      return this.turnUsage;
    } catch {
      return this.turnUsage;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  resetTurn() {
    this.turnUsage = undefined;
  }
}
