/**
 * Measured evidence for a recording: transcript words, waveform levels and (for replay) the saved
 * dialogue-scan windows. Everything here is read-only against the engine and the library.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCapture, SOURCE_AUDIO_CLOCK } from "../../packages/render/src/exec.ts";
import type { DialogueDetections } from "../../packages/shared/src/inspection.ts";
import { flattenWords } from "../../packages/shared/src/transcriptSearch.ts";
import type { Transcript } from "../../packages/timeline/src/index.ts";
import type { Engine } from "./engine.ts";
import { merge, total } from "./intervals.ts";
import type { Levels, MediaEvidence, Word } from "./metrics.ts";
import { appSupportDir, cacheDir, checkedPath, dataDir, fileComponent, readJson, writeJson } from "./paths.ts";
import type { MediaInfo } from "./timeline.ts";

/** Resolution requested from the engine's cached waveform. */
export const ENGINE_LEVEL_RATE = 50;
const MAX_POINTS = 20000;
/** Independent full-band levels: 16 kHz decode, 10 ms RMS frames. Sibilants and breaths above 4 kHz stay visible. */
export const FULL_BAND = { sampleRate: 16000, hop: 0.01 };

export interface StoredEvidence extends MediaEvidence {
  wordsSource: "transcript" | "none";
  levelSource: "full-band 16 kHz" | "engine waveform" | "engine 8 kHz";
  /** The engine's own levels, as seen by dialogue_check_join and the scan. */
  engineLevels?: Levels;
}

const dbOf = (rms: number) => Math.round(Math.max(-120, 20 * Math.log10(rms + 1e-7)) * 10) / 10;

/** The engine's prepared waveform as RMS dBFS. Never starts extraction. */
export async function engineLevels(engine: Engine, media: MediaInfo): Promise<Levels | undefined> {
  if (!media.duration) return undefined;
  const db: number[] = [];
  const chunk = MAX_POINTS / ENGINE_LEVEL_RATE;
  for (let from = 0; from < media.duration - 1e-9; from += chunk) {
    const points = Math.min(MAX_POINTS, Math.ceil((media.duration - from) * ENGINE_LEVEL_RATE - 1e-9));
    try {
      const wf = await engine.waveform(media.id, from, from + points / ENGINE_LEVEL_RATE, points);
      db.push(...wf.rms.map(dbOf));
    } catch (err) {
      if (!db.length) return undefined; // Waveform not prepared; the edge metrics report "unknown".
      throw err;
    }
  }
  return { from: 0, step: 1 / ENGINE_LEVEL_RATE, db };
}

export function ffmpegPath(): string {
  if (process.env.SCARLET_FFMPEG) return process.env.SCARLET_FFMPEG;
  const bundled = "/Applications/Scarlet.app/Contents/MacOS/ffmpeg";
  return process.platform === "darwin" && existsSync(bundled) ? bundled : "ffmpeg";
}

/** RMS dBFS of the first audio stream mixed to mono, decoded from the original file (read-only). */
export async function fullBandLevels(file: string, opts = FULL_BAND): Promise<Levels> {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", file, "-vn", "-map", "0:a:0", "-af", SOURCE_AUDIO_CLOCK,
    "-ac", "1", "-ar", String(opts.sampleRate), "-f", "s16le", "-"];
  const per = Math.round(opts.sampleRate * opts.hop);
  const db: number[] = [];
  let sum = 0, count = 0, carry: Buffer | undefined;
  await runCapture(ffmpegPath(), args, { onStdoutChunk(chunk) {
    const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
    const whole = buf.length & ~1;
    for (let i = 0; i < whole; i += 2) {
      const v = buf.readInt16LE(i) / 32768;
      sum += v * v;
      if (++count === per) { db.push(dbOf(Math.sqrt(sum / per))); sum = 0; count = 0; }
    }
    carry = whole < buf.length ? buf.subarray(whole) : undefined;
  } });
  if (count) db.push(dbOf(Math.sqrt(sum / count)));
  return { from: 0, step: opts.hop, db };
}

/** The original recording inside Scarlet's library. */
export function mediaFile(projectId: string, media: MediaInfo): string | undefined {
  if (!media.path) return undefined;
  const projects = join(appSupportDir(), "data", "projects");
  const file = checkedPath(projects, join(projects, fileComponent(projectId), "media", fileComponent(media.path)));
  return existsSync(file) ? file : undefined;
}

/** Transcript words in transcript_get order (flattenWords), so stored plans' word references keep their indices. */
export async function fetchWords(engine: Engine, mediaId: string): Promise<Word[] | undefined> {
  const transcript = await engine.transcript(mediaId);
  if (!transcript) return undefined;
  return flattenWords(transcript as Transcript).map(w => ({ text: w.text, start: w.start, end: w.end }));
}

/**
 * Words and levels, cached per recording content outside the repository. Primary levels are full band
 * from the original file when it and ffmpeg are available. The engine's waveform is kept alongside.
 */
export async function mediaEvidence(engine: Engine, projectId: string, media: MediaInfo, refresh = false): Promise<StoredEvidence> {
  const name = fileComponent(`${fileComponent(media.id)}-${(media.hash ?? String(media.duration ?? "")).slice(0, 16)}-v3.json`);
  const path = checkedPath(dataDir(), join(cacheDir(), "evidence", name));
  if (!refresh && existsSync(path)) return readJson<StoredEvidence>(path);
  const file = mediaFile(projectId, media);
  const [words, engineView, full] = await Promise.all([
    fetchWords(engine, media.id), engineLevels(engine, media),
    file ? fullBandLevels(file).catch(err => { console.warn(`Full-band levels unavailable (${(err as Error).message}); using the engine waveform.`); return undefined; }) : undefined,
  ]);
  const evidence: StoredEvidence = { mediaId: media.id, duration: media.duration, words: words ?? [], levels: full ?? engineView,
    wordsSource: words ? "transcript" : "none", levelSource: full ? "full-band 16 kHz" : "engine waveform", ...(full && engineView && { engineLevels: engineView }) };
  writeJson(path, evidence);
  return evidence;
}

// ---------------------------------------------------------------------------
// Dialogue scan windows (the first-cut detectors' evidence), for replay
// ---------------------------------------------------------------------------

export interface ScanWindowWaveform { from: number; to: number; peaks: number[]; rms: number[] }
export interface ScanCapture {
  mediaId: string;
  audioStream: number;
  /** "library": read from the database; "engine": served for the engine's current detector settings. */
  source: "engine" | "library";
  /** Detector settings fingerprint. Windows saved under different settings can differ, so each set is kept apart. */
  fingerprint: string;
  coverage: number;
  pages: Array<{ from: number; to: number; detections: DialogueDetections }>;
}
/** Peaks and RMS per window, read exactly as the MCP reads them: ceil(seconds × 50) points. Keyed "from-to". */
export type ScanWaveforms = Record<string, ScanWindowWaveform>;
export const windowKey = (from: number, to: number) => `${from}-${to}`;

/**
 * Every saved set of scan windows for a recording. The library database is read directly (read-only) because
 * the engine only serves windows for its current detector settings; without it, the engine's windows are used.
 */
export async function fetchScans(engine: Engine, projectId: string, media: MediaInfo, opts: { fingerprint?: string } = {}): Promise<{ scans: ScanCapture[]; waveforms: ScanWaveforms }> {
  if (!media.duration) return { scans: [], waveforms: {} };
  const audioStream = media.audioStream ?? 0;
  const coverage = (pages: Array<{ from: number; to: number }>) => Math.round(1000 * total(merge(pages.map(p => ({ start: p.from, end: p.to })))) / media.duration!) / 1000;
  let scans: ScanCapture[] = (await libraryScanPages(media.id, opts.fingerprint)).map(set => ({
    mediaId: media.id, audioStream, source: "library" as const, fingerprint: set.fingerprint, coverage: coverage(set.pages), pages: set.pages,
  }));
  if (!scans.length) {
    const saved = await engine.checkpoints(projectId, media.id, 0, media.duration).catch(() => []);
    const pages = [];
    for (const p of saved) pages.push({ from: p.start, to: p.end, detections: await engine.savedDetections(projectId, media.id, p.start, p.end) as DialogueDetections });
    if (pages.length) scans = [{ mediaId: media.id, audioStream, source: "engine", fingerprint: "current", coverage: coverage(pages), pages }];
  }
  scans.sort((a, b) => b.coverage - a.coverage);
  const waveforms: ScanWaveforms = {};
  for (const page of scans.flatMap(s => s.pages)) {
    const key = windowKey(page.from, page.to);
    if (waveforms[key]) continue;
    const points = Math.max(10, Math.ceil((page.to - page.from) * 50));
    const wf = await engine.waveform(media.id, page.from, page.to, points);
    waveforms[key] = { from: page.from, to: page.to, peaks: wf.peaks, rms: wf.rms };
  }
  return { scans, waveforms };
}

/** Read-only access to the scan windows saved in the library, one set per detector fingerprint. */
export async function libraryScanPages(mediaId: string, fingerprint?: string): Promise<Array<{ fingerprint: string; pages: Array<{ from: number; to: number; detections: DialogueDetections }> }>> {
  const path = join(appSupportDir(), "data", "scarlet.db");
  if (!existsSync(path)) return [];
  // node:sqlite is built into Node 22.5+. Loaded lazily so the rest of the evals run without it.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT fingerprint, start, end, result FROM dialogue_scan_pages WHERE media_id = ?${fingerprint ? " AND fingerprint LIKE ?" : ""} ORDER BY fingerprint, start, end`)
      .all(...(fingerprint ? [mediaId, fingerprint + "%"] : [mediaId])) as Array<{ fingerprint: string; start: number; end: number; result: string }>;
    const sets = new Map<string, Array<{ from: number; to: number; detections: DialogueDetections }>>();
    for (const r of rows) sets.set(r.fingerprint, [...(sets.get(r.fingerprint) ?? []), { from: r.start, to: r.end, detections: JSON.parse(r.result) as DialogueDetections }]);
    return [...sets].map(([fp, pages]) => ({ fingerprint: fp, pages }));
  } finally {
    db.close();
  }
}
