import { totalmem } from "node:os";
import { logId } from "../logText.js";
import { editorFirst } from "./editorFirst.js";

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
 * Work a request is waiting on this moment (`asked`), such as the page a pass's tool call reads or the joins its
 * repeat check hears, ranks 1 whatever recording it is on, and goes ahead of other work of its rank. A pass reads its
 * last pages and checks its joins after its scan has let the recording go, and then they ranked 2, behind every
 * transcript under way: on 2026-11-16 pages of about a second's work waited 52 s to 1 min 41 s each behind another
 * recording's alignment, and the pass waited with them.
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
export type AudioWork = { mediaId: string; kind: "transcript" | "alignment" | "speakers" | "page";
  /** A request is waiting on this work now. Work already queued becomes asked when a request joins it. */
  asked?: boolean };

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

  /** Recordings a pass is reading, across both lanes. */
  focusedMediaIds(): IterableIterator<string> {
    return this.focused.keys();
  }

  /** Whether a dialogue pass is reading any recording now. */
  reading(): boolean {
    return this.focused.size > 0;
  }

  rank(work: AudioWork): number {
    if (!this.focused.has(work.mediaId)) return work.asked ? 1 : 2;
    return work.kind === "transcript" ? 0 : 1;
  }

  /** Whether `work` goes ahead of `other`: it ranks ahead, or ranks the same and a request is waiting on it alone. */
  private ahead(work: AudioWork, other: AudioWork) {
    return this.rank(work) - this.rank(other) || Number(!!other.asked) - Number(!!work.asked);
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
    const lane = this.name === "Whisper lane" ? "whisper" : this.name === "page Whisper lane" ? "page-whisper" : "audio";
    const target = `lane=${lane} work=${work.kind} media=${logId(work.mediaId)}`;
    if (resumes) {
      // The lane was kept for this step.
    } else if (this.busy) {
      await new Promise<void>((resolve, reject) => {
        const slow = this.log ? setTimeout(() => {
          const blocker = this.current ?? this.held?.work;
          this.log?.(`[audio] waiting ${target} wait_ms=${Math.max(0, Date.now() - queuedAt)} ahead=${ahead}` +
            (blocker ? ` blocker_work=${blocker.kind} blocker=${logId(blocker.mediaId)}` : ""));
        }, LOG_WAIT_MS) : undefined;
        slow?.unref();
        const entry = { work, seq, start: () => { clearTimeout(slow); signal?.removeEventListener("abort", cancel); resolve(); } };
        const cancel = () => {
          clearTimeout(slow);
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          this.log?.(`[audio] cancelled_while_waiting ${target} wait_ms=${Math.max(0, Date.now() - queuedAt)}`);
          reject(signal!.reason);
        };
        this.waiting.push(entry);
        signal?.addEventListener("abort", cancel, { once: true });
        // Work ranked ahead of the step the lane is kept for doesn't wait for it.
        if (this.held && this.ahead(work, this.held.work) < 0) {
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
    const waited = Math.max(0, startedAt - queuedAt);
    if (waited >= LOG_WAIT_MS) this.log?.(`[audio] started ${target} wait_ms=${waited}`);
    const slow = this.log ? setTimeout(() => this.log?.(`[audio] running ${target} elapsed_ms=${Math.max(0, Date.now() - startedAt)}`), LOG_RUN_MS) : undefined;
    slow?.unref();
    let failed = false;
    try {
      signal?.throwIfAborted();
      // A recording no pass is reading is nobody's to wait for, unless work a pass needs waits behind it: it yields to
      // the editor's playback meanwhile. So does a scan page read ahead of any pass, until a pass reads its recording;
      // a page a pass reads or asks for is the pass's from the start.
      return await (work.kind === "page" && this.rank(work) < 2 ? job() : editorFirst.run(() => this.rank(work) === 2 && !this.urgentWaiting(), job));
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      clearTimeout(slow);
      const ran = Math.max(0, Date.now() - startedAt);
      if (this.log && (waited >= LOG_WAIT_MS || ran >= LOG_RUN_MS)) {
        this.log(`[audio] finished ${target} outcome=${signal?.aborted ? "cancelled" : failed ? "failed" : "done"} wait_ms=${waited} elapsed_ms=${ran}`);
      }
      this.current = undefined;
      if (options.more && !failed) this.hold(work);
      else {
        this.begun.delete(key);
        this.next();
      }
    }
  }

  /** The step `work` kept the lane for won't come: let the next work have it now rather than when the hold runs out. */
  release(work: AudioWork) {
    if (!this.held || workKey(this.held.work) !== workKey(work)) return;
    this.unhold();
    this.begun.delete(workKey(work));
    this.next();
  }

  /** A late cleanup only releases the reservation made by this attempt’s own step. */
  finish(...steps: AudioWork[]) {
    if (this.held && steps.includes(this.held.work)) this.release(this.held.work);
  }

  /** A request now waits on `work`. Queued, it stops waiting for a step the lane is kept for that it now goes ahead of. */
  ask(work: AudioWork) {
    work.asked = true;
    if (this.held && this.waiting.some(entry => entry.work === work) && this.ahead(work, this.held.work) < 0) {
      this.unhold();
      this.next();
    }
  }

  /** Whether work a pass needs is waiting for the lane. */
  urgentWaiting(): boolean {
    return this.waiting.some(entry => this.rank(entry.work) < 2);
  }

  /** Work waiting for the lane, in the order it would run. */
  queued(): AudioWork[] {
    return this.ordered().map(entry => entry.work);
  }

  /** Keep the lane for the next step of `work`, unless something ranked ahead of it is waiting. */
  private hold(work: AudioWork) {
    const [first] = this.ordered();
    if (first && this.ahead(first.work, work) < 0) {
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
    return [...this.waiting].sort((a, b) => this.ahead(a.work, b.work) || place(a) - place(b) || a.seq - b.seq);
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
const pageWhisperLanes = new Map<string, AudioLane>();

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

/** Memory two Whisper runs at once need room in: each holds its own copy of the model on the GPU. */
const PAGE_WHISPER_MEMORY = 16 * 1024 ** 3;

/**
 * The lane a dialogue pass's scan pages take their Whisper turns in once the recording has its words. Where Whisper has
 * a lane of its own, it is a second one beside it, so a page's Whisper runs while the transcript's reread is read in the
 * first: one Whisper run leaves the GPU room for another. Three minutes of a recording read a minute at a time took
 * 2.75 s one after another and 1.84 s all at once, two minutes 1.40 s at once, with the same words (M5 Max,
 * 2026-11-26). In one lane the pages and the reread took turns, minute by minute. A Mac with less memory keeps the one
 * lane.
 */
export function pageWhisperLane(ctx: { paths: { root: string }; log?: (message: string) => void }, separate: boolean | undefined,
  memory = totalmem()): AudioLane {
  const lane = whisperLane(ctx, separate);
  if (!separate || memory < PAGE_WHISPER_MEMORY) return lane;
  let own = pageWhisperLanes.get(ctx.paths.root);
  if (!own) pageWhisperLanes.set(ctx.paths.root, own = lane.sibling("page Whisper lane"));
  return own;
}

/** A request now waits on `work`, which may be queued in any of the engine's lanes. */
export function askFor(ctx: { paths: { root: string } }, work: AudioWork) {
  work.asked = true;
  lanes.get(ctx.paths.root)?.ask(work);
  whisperLanes.get(ctx.paths.root)?.ask(work);
  pageWhisperLanes.get(ctx.paths.root)?.ask(work);
}
