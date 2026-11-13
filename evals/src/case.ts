/** An eval case: one project, a source version to cut from, the request, evidence and an optional reference. */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Change, Timeline } from "../../packages/timeline/src/index.ts";
import type { TaskRecord } from "./engine.ts";
import type { ScanCapture, ScanWaveforms, StoredEvidence } from "./evidence.ts";
import type { EventLike, LabeledRange, MediaEvidence } from "./metrics.ts";
import { caseDir, casesDir, checkedPath, fileComponent, readJson } from "./paths.ts";
import type { PublishedReference } from "./published.ts";
import type { MediaInfo } from "./timeline.ts";

export type Suite = "capability" | "regression";

export interface CaseFile {
  schema: 1;
  id: string;
  /** Capability cases measure how good cuts are; regression cases guard behavior that already works. Report them separately. */
  suite: Suite;
  createdAt: string;
  notes?: string;
  projectId: string;
  fps: number;
  media: MediaInfo[];
  /** Version every trial branches from. */
  sourceVersion: string;
  /** Recordings heard in the source version. */
  dialogueMedia: string[];
  request: { instruction: string; skillIds: string[]; skillNames: string[]; mediaId?: string; time?: number };
  origin?: { taskId: string; agent?: string; model?: string; effort?: string };
  reference?: {
    label: string;
    /** The editor's finished or approved cut. */
    version?: string;
    /** Editor-approved ("cut") and skipped ("keep") review items, plus applied cuts the editor kept. */
    labels?: LabeledRange[];
    /** The video that was published, matched to the recordings. Scored instead of `version` when present. */
    published?: PublishedReference;
  };
}

export interface LoadedCase {
  file: CaseFile;
  dir: string;
  timeline(version: string): Timeline | undefined;
  evidence: Map<string, MediaEvidence>;
  /** Saved dialogue-scan window sets for a recording (most complete first) and their waveforms. */
  scans(mediaId: string): { scans: ScanCapture[]; waveforms: ScanWaveforms } | undefined;
  /** The run the case was built from, when it was built with --from-task. */
  origin(): { task: TaskRecord; events: EventLike[]; changes: Change[] } | undefined;
}

export const timelinePath = (dir: string, version: string) => checkedPath(dir, join(dir, "timelines", fileComponent(version) + ".json"));
export const evidencePath = (dir: string, mediaId: string) => checkedPath(dir, join(dir, "evidence", fileComponent(mediaId) + ".json"));
export const scanPath = (dir: string, mediaId: string) => checkedPath(dir, join(dir, "scan", fileComponent(mediaId) + ".json"));

function readManifest(id: string): CaseFile {
  const dir = caseDir(id);
  const file = readJson<CaseFile>(checkedPath(dir, join(dir, "case.json")));
  if (file.id !== id) throw new Error("Evaluation case ID does not match its directory");
  return file;
}

export function loadCase(id: string): LoadedCase {
  const dir = caseDir(id);
  const file = readManifest(id);
  const evidence = new Map<string, MediaEvidence>();
  for (const mediaId of file.dialogueMedia) {
    const path = evidencePath(dir, mediaId);
    if (existsSync(path)) evidence.set(mediaId, readJson<StoredEvidence>(path));
  }
  return {
    file, dir, evidence,
    timeline: v => existsSync(timelinePath(dir, v)) ? readJson<Timeline>(timelinePath(dir, v)) : undefined,
    origin: () => existsSync(join(dir, "origin", "task.json"))
      ? { ...readJson<{ task: TaskRecord; events: EventLike[] }>(checkedPath(dir, join(dir, "origin", "task.json"))), changes: readJson<Change[]>(checkedPath(dir, join(dir, "origin", "changes.json"))) }
      : undefined,
    scans: m => existsSync(scanPath(dir, m)) ? readJson<{ scans: ScanCapture[]; waveforms: ScanWaveforms }>(scanPath(dir, m)) : undefined,
  };
}

export function listCases(): CaseFile[] {
  if (!existsSync(casesDir())) return [];
  return readdirSync(casesDir()).filter(d => existsSync(join(casesDir(), d, "case.json")))
    .map(readManifest);
}
