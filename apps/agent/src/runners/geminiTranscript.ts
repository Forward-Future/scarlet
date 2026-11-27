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

/** One model step's tokens, from its `PLANNER_RESPONSE`: what it sent uncached and cached, and what it wrote. */
export interface StepTokens { step?: number; input: number; cacheRead: number; cacheWrite: number; output: number }
/** A step that read much less from the cache than the step before sent: Gemini billed the rest of it uncached. */
export interface CacheMiss { step?: number; context: number; cached: number; missed: number }
/** A run's steps: how many, the largest context one sent, and its cache misses with the tokens they re-sent uncached. */
export interface StepsReport { steps: number; peakContext: number; misses: CacheMiss[]; missedTokens: number }

/** Least shortfall, in tokens and as a share of the step before's context, read as a miss rather than a trimmed prompt. */
export const MISS_TOKENS = 4_096;
export const MISS_SHARE = 0.25;

/** The context a step sent: its input, uncached and cached. */
const contextOf = (s: StepTokens) => s.input + s.cacheRead + s.cacheWrite;

/**
 * Whether `step` missed the cache: agy's cache holds the whole of the request before (its read equals that request's
 * input, step after step), so a read far under it means Gemini sent that context again uncached. A pass lost about
 * $0.87 that way that nothing recorded showed (2026-11-26).
 */
export function cacheMiss(before: StepTokens, step: StepTokens): CacheMiss | undefined {
  const context = contextOf(before), missed = context - step.cacheRead;
  return missed > Math.max(MISS_TOKENS, context * MISS_SHARE) ? { ...(step.step !== undefined && { step: step.step }), context, cached: step.cacheRead, missed } : undefined;
}

/** What a run's steps add up to, or nothing when the transcript gave none. */
export function stepsReport(steps: readonly StepTokens[]): StepsReport | undefined {
  if (!steps.length) return undefined;
  const misses = steps.slice(1).flatMap((step, i) => cacheMiss(steps[i]!, step) ?? []);
  return { steps: steps.length, peakContext: Math.max(...steps.map(contextOf)), misses, missedTokens: misses.reduce((sum, m) => sum + m.missed, 0) };
}

export class TranscriptUsageTailer {
  private path: string | undefined;
  private offset = 0;
  private seenSteps = new Set<number>();
  private turnUsage: AgentUsage | undefined;
  /** Every step of the run, across its turns, for `report`. */
  private steps: StepTokens[] = [];

  /** `onMiss` hears of each cache miss as its step is read. */
  constructor(private readonly onMiss?: (miss: CacheMiss) => void) {}

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
    this.steps = [];
  }

  /** The run's steps so far: how many, the peak context and the cache misses. */
  report(): StepsReport | undefined {
    return stepsReport(this.steps);
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
        const step: StepTokens = { ...(typeof val.step_index === "number" && Number.isFinite(val.step_index) && { step: val.step_index }),
          input: stepUsage.inputTokens, cacheRead: stepUsage.cacheReadTokens, cacheWrite: stepUsage.cacheWriteTokens, output: stepUsage.outputTokens };
        const before = this.steps.at(-1);
        const miss = before && cacheMiss(before, step);
        this.steps.push(step);
        if (miss) this.onMiss?.(miss);
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
