import { humanDuration } from "../logText.js";

/**
 * Local audio models (Whisper, word alignment and speaker analysis) each use most of the CPU. Run side by
 * side they slow each other several times over: a 58-minute transcript that takes about 2 minutes alone
 * took 17 beside a second transcript and a dialogue scan. One lane per engine runs them in turn, in the
 * order a dialogue pass needs them:
 *
 *  0. Whisper on a recording a dialogue pass is reading, since scan pages take their word numbers from its transcript;
 *  1. that recording's word alignment and scan pages, and its speaker analysis on a machine without the cores to
 *     run that beside the lane (`speakersRunBeside`);
 *  2. everything else, such as transcripts of the other recordings.
 *
 * Rank is read when the lane frees, so a transcript that started in the background moves up as soon as
 * a pass starts reading its recording. Equal ranks run first come, first served, except that work already
 * under way finishes first: a background transcript is Whisper and then word alignment in five-minute turns,
 * and each turn queues anew. Without that, two recordings' transcripts alternated, and neither was done until
 * both were: on 2026-11-06 the first recording's alignment waited behind the second's entire Whisper run. A step
 * that says another follows keeps the lane for it, unless higher-ranked work is waiting.
 *
 * The transcript is saved when Whisper ends, so a pass reads it while alignment goes on. For a recording a pass
 * is reading, alignment therefore takes short turns that say nothing follows, and scan pages run between them:
 * on 2026-11-07 a pass waited 11.5 minutes for a 58-minute recording's alignment before its first page could run.
 * Alignment is Whisper's work continued, so it resumes the lane Whisper kept for it.
 *
 * Where Whisper runs on the GPU and the other models on the CPU (the bundled build on Apple silicon), Whisper has
 * a lane of its own (`whisperLane`): it took 20 s for a 58-minute recording alone and barely longer beside the CPU
 * models, so a recording's Whisper, and each scan page's, runs while the CPU aligns. The two lanes rank work the same
 * way and share what a pass is reading.
 *
 * Voice notes and other short interactive transcriptions don't use the lane.
 */
export type AudioWork = { mediaId: string; kind: "transcript" | "alignment" | "speakers" | "page" };

/** Log work that waited this long for the lane or held it this long, so a stalled pass shows what it queued behind. */
const LOG_WAIT_MS = 30_000;
const LOG_RUN_MS = 60_000;
/** How long the lane stays free for the next step of work that said one follows. */
const HOLD_MS = 10_000;

const workKey = (work: AudioWork) => `${work.kind === "alignment" ? "transcript" : work.kind}/${work.mediaId}`;

export class AudioLane {
  private busy = false;
  private seq = 0;
  private readonly waiting: Array<{ work: AudioWork; seq: number; start(): void }> = [];
  /** When each piece of work under way first got the lane, so it finishes before equal-ranked work starts. */
  private readonly begun = new Map<string, number>();
  /** The lane kept free for the next step of the work that just ran. */
  private held: { work: AudioWork; timer: ReturnType<typeof setTimeout> } | undefined;
  private current: AudioWork | undefined;

  /** `focused`: the recordings passes are reading, by how many. Lanes of one engine share it. */
  constructor(private readonly log?: (message: string) => void, private readonly focused = new Map<string, number>(),
    private readonly name = "audio lane") {}

  /** A second lane that ranks work by the same recordings. */
  sibling(name: string) {
    return new AudioLane(this.log, this.focused, name);
  }

  /** Mark a recording as the one a dialogue pass is reading until the returned release is called. */
  focus(mediaId: string): () => void {
    this.focused.set(mediaId, (this.focused.get(mediaId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.focused.get(mediaId) ?? 1) - 1;
      if (left > 0) this.focused.set(mediaId, left);
      else this.focused.delete(mediaId);
    };
  }

  /** Whether a dialogue pass is reading this recording now. */
  focusedOn(mediaId: string): boolean {
    return this.focused.has(mediaId);
  }

  rank(work: AudioWork): number {
    if (!this.focused.has(work.mediaId)) return 2;
    return work.kind === "transcript" ? 0 : 1;
  }

  /**
   * Run `job` once the lane is free and nothing ranked ahead of it is waiting. With `more`, another step of the
   * same work follows, and the lane waits briefly for it instead of starting equal- or lower-ranked work.
   */
  async run<T>(work: AudioWork, signal: AbortSignal | undefined, job: () => Promise<T>, options: { more?: boolean } = {}): Promise<T> {
    signal?.throwIfAborted();
    const queuedAt = Date.now();
    const seq = this.seq++;
    const key = workKey(work);
    const resumes = this.held !== undefined && workKey(this.held.work) === key;
    if (resumes) this.unhold();
    const behind = this.busy && !resumes ? this.current ?? this.held?.work : undefined;
    const ahead = behind ? this.waiting.length + 1 : 0;
    if (resumes) {
      // The lane was kept for this step.
    } else if (this.busy) {
      await new Promise<void>((resolve, reject) => {
        const entry = { work, seq, start: () => { signal?.removeEventListener("abort", cancel); resolve(); } };
        const cancel = () => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal!.reason);
        };
        this.waiting.push(entry);
        signal?.addEventListener("abort", cancel, { once: true });
        // Work ranked ahead of the step the lane is kept for doesn't wait for it.
        if (this.held && this.rank(work) < this.rank(this.held.work)) {
          this.unhold();
          this.next();
        }
      });
    } else this.busy = true;
    if (!this.begun.has(key)) {
      this.begun.set(key, seq);
      if (this.begun.size > 256) this.begun.delete(this.begun.keys().next().value!);
    }
    const startedAt = Date.now();
    this.current = work;
    let failed = false;
    try {
      signal?.throwIfAborted();
      return await job();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const waited = startedAt - queuedAt, ran = Date.now() - startedAt;
      if (this.log && (waited >= LOG_WAIT_MS || ran >= LOG_RUN_MS)) {
        const queue = waited >= LOG_WAIT_MS ? `waited ${humanDuration(waited)} for the ${this.name}${behind ? ` behind ${behind.kind} ${behind.mediaId}` : ""}${ahead > 1 ? ` (${ahead} jobs ahead)` : ""}, then ` : "";
        this.log(`[audio] ${work.kind} ${work.mediaId}: ${queue}${failed ? "failed" : "ran"} for ${humanDuration(ran)}`);
      }
      this.current = undefined;
      if (options.more && !failed) this.hold(work);
      else {
        this.begun.delete(key);
        this.next();
      }
    }
  }

  /** Work waiting for the lane, in the order it would run. */
  queued(): AudioWork[] {
    return this.ordered().map(entry => entry.work);
  }

  /** Keep the lane for the next step of `work`, unless something ranked ahead of it is waiting. */
  private hold(work: AudioWork) {
    const [first] = this.ordered();
    if (first && this.rank(first.work) < this.rank(work)) {
      this.next();
      return;
    }
    const timer = setTimeout(() => {
      this.held = undefined;
      this.next();
    }, HOLD_MS);
    timer.unref?.();
    this.held = { work, timer };
  }

  private unhold() {
    if (this.held) clearTimeout(this.held.timer);
    this.held = undefined;
  }

  private ordered() {
    // Work already under way keeps the place it had when it first got the lane.
    const place = (entry: { work: AudioWork; seq: number }) => Math.min(entry.seq, this.begun.get(workKey(entry.work)) ?? entry.seq);
    return [...this.waiting].sort((a, b) => this.rank(a.work) - this.rank(b.work) || place(a) - place(b) || a.seq - b.seq);
  }

  private next() {
    const [first] = this.ordered();
    if (!first) { this.busy = false; return; }
    this.waiting.splice(this.waiting.indexOf(first), 1);
    first.start();
  }
}

const lanes = new Map<string, AudioLane>();
const whisperLanes = new Map<string, AudioLane>();

/** The engine's audio lane. One per data directory, which is one per engine. */
export function audioLane(ctx: { paths: { root: string }; log?: (message: string) => void }): AudioLane {
  let lane = lanes.get(ctx.paths.root);
  if (!lane) lanes.set(ctx.paths.root, lane = new AudioLane(ctx.log?.bind(ctx)));
  return lane;
}

/**
 * The lane local Whisper takes its turn in: one of its own when it runs on the GPU beside the CPU models
 * (`TranscriptionProvider.separateWhisperLane`), and otherwise the engine's audio lane.
 */
export function whisperLane(ctx: { paths: { root: string }; log?: (message: string) => void }, separate: boolean | undefined): AudioLane {
  const lane = audioLane(ctx);
  if (!separate) return lane;
  let own = whisperLanes.get(ctx.paths.root);
  if (!own) whisperLanes.set(ctx.paths.root, own = lane.sibling("Whisper lane"));
  return own;
}
