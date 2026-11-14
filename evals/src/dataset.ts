/**
 * Dataset builder: snapshot an eval case from the engine into the external data folder.
 *
 *   tsx evals/src/dataset.ts build --project prj_… --from-task tsk_… [--reference-decisions] [--with-scan]
 *   tsx evals/src/dataset.ts build --project prj_… --source <version> --reference-version <editor's final>
 *   tsx evals/src/dataset.ts list
 *
 * Reads only. A case holds the source version, the request, words and levels per dialogue recording,
 * optionally the saved dialogue-scan windows (for replay), and a reference: a version id and/or labels
 * derived from the editor's approve/skip decisions.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appliedCutReview, planCutReview } from "../../packages/timeline/src/index.ts";
import { cli, isMain, list, main } from "./args.ts";
import { evidencePath, listCases, scanPath, timelinePath, type CaseFile, type Suite } from "./case.ts";
import { Engine } from "./engine.ts";
import { fetchScans, fetchWords, mediaEvidence, mediaFile } from "./evidence.ts";
import { gatherTask, mediaInfo } from "./evaluate.ts";
import { intersect } from "./intervals.ts";
import type { LabeledRange, MediaEvidence, Word } from "./metrics.ts";
import { caseDir, dataDir, readJson, writeJson } from "./paths.ts";
import { measurePicture } from "./pictureMeasure.ts";
import { publishedReference } from "./published.ts";
import { audibleMediaIds, byMedia, timelineRangeToSource } from "./timeline.ts";

const USAGE = `Usage:
  dataset.ts build --project <id> (--from-task <taskId> | --source <version>)
             [--reference-version <v>] [--reference-decisions] [--with-scan] [--fingerprint <f>]
             [--published-media <id> | --published-words <file.json>] [--published-label <text>]
             [--published-video <file>] [--picture-every <seconds>]
             [--id <case id>] [--suite capability|regression] [--instruction <text>] [--skill <name,...>]
             [--media <id>] [--notes <text>] [--force] [--refresh] [--engine <url>]
  dataset.ts list

--published-media names the published video imported into any project of this library, once it has a transcript;
--published-words reads its words from a file instead ([{ text, start, end }], seconds on the published video).

--published-video measures the published picture as well: where the camera and the screen sit in its frame,
every --picture-every seconds (default 2). It reads the file and the original recordings with ffmpeg.

Cases are written to $SCARLET_EVAL_DATA/cases (default: Scarlet's application support folder /evals).`;

export interface BuildOptions {
  projectId: string;
  fromTask?: string;
  sourceVersion?: string;
  referenceVersion?: string;
  referenceDecisions?: boolean;
  /** The published video as a media asset with a transcript, or its words read from a file. */
  publishedMedia?: string;
  publishedWords?: Word[];
  publishedLabel?: string;
  /** The published video's file, to measure its picture. */
  publishedVideo?: string;
  pictureEvery?: number;
  withScan?: boolean;
  fingerprint?: string;
  id?: string;
  suite?: Suite;
  instruction?: string;
  skills?: string[];
  mediaId?: string;
  notes?: string;
  force?: boolean;
  refresh?: boolean;
}

export async function buildCase(engine: Engine, opts: BuildOptions): Promise<{ file: CaseFile; dir: string; warnings: string[] }> {
  const warnings: string[] = [];
  const project = await engine.project(opts.projectId);
  const media = project.media.map(mediaInfo);
  const skills = await engine.skills();
  const artifacts = opts.fromTask ? await gatherTask(engine, opts.fromTask) : undefined;
  if (artifacts && artifacts.projectId !== project.id) throw new Error(`Task ${opts.fromTask} belongs to ${artifacts.projectId}.`);
  const sourceVersion = opts.sourceVersion ?? artifacts?.versions.source;
  if (!sourceVersion) throw new Error("Name the version to cut from with --source, or derive it with --from-task.");

  const task = artifacts?.task;
  const skillIds = opts.skills?.length
    ? opts.skills.map(s => skills.find(k => k.id === s || k.name === s)?.id ?? s)
    : task?.context.skillIds ?? skills.filter(k => k.name === "dialogue-pass").map(k => k.id);
  const request: CaseFile["request"] = {
    instruction: opts.instruction ?? String(task?.context.message ?? task?.instruction ?? "/dialogue-pass"),
    skillIds,
    skillNames: skillIds.map(id => skills.find(k => k.id === id)?.name).filter((n): n is string => !!n),
    ...((opts.mediaId ?? task?.context.mediaId) && { mediaId: opts.mediaId ?? task?.context.mediaId }),
    ...(task?.context.time !== undefined && { time: task.context.time }),
  };

  const id = opts.id ?? `${project.id}-${sourceVersion.slice(0, 8)}`;
  const dir = caseDir(id);
  if (existsSync(join(dir, "case.json")) && !opts.force) throw new Error(`Case ${id} exists. Pass --force to rebuild it or --id to name another.`);

  const source = artifacts?.timelines.get(sourceVersion) ?? await engine.timeline(project.id, sourceVersion);
  writeJson(timelinePath(dir, sourceVersion), source);
  const dialogueMedia = audibleMediaIds(source, media);
  if (!dialogueMedia.length) warnings.push("The source version has no audible recording.");
  const recordings = new Map<string, MediaEvidence>();
  for (const mediaId of dialogueMedia) {
    const m = media.find(x => x.id === mediaId)!;
    const evidence = await mediaEvidence(engine, project.id, m, opts.refresh);
    if (!evidence.words?.length) warnings.push(`${mediaId} has no transcript; word metrics will be empty.`);
    if (!evidence.levels) warnings.push(`${mediaId} has no levels; edges will be "unknown".`);
    writeJson(evidencePath(dir, mediaId), evidence);
    recordings.set(mediaId, evidence);
    if (opts.withScan) {
      const captured = await fetchScans(engine, project.id, m, { fingerprint: opts.fingerprint });
      if (captured.scans.length) writeJson(scanPath(dir, mediaId), captured);
      else warnings.push(`${mediaId} has no saved dialogue-scan windows; replay is unavailable for it.`);
      for (const s of captured.scans) console.log(`  scan ${mediaId} ${s.fingerprint.slice(0, 12)} (${s.source}): ${s.pages.length} windows, ${Math.round(s.coverage * 100)}% coverage`);
    }
  }

  let reference: CaseFile["reference"];
  if (opts.referenceVersion) {
    writeJson(timelinePath(dir, opts.referenceVersion), await engine.timeline(project.id, opts.referenceVersion));
    reference = { label: `version ${opts.referenceVersion}`, version: opts.referenceVersion };
  }
  if (opts.referenceDecisions) {
    if (!artifacts) throw new Error("--reference-decisions needs --from-task: the run whose review the editor decided.");
    const labels: LabeledRange[] = [];
    const review = artifacts.reviewExport;
    for (const cut of review?.cuts ?? []) {
      if (cut.decision !== "approved" && cut.decision !== "skipped") continue;
      for (const [mediaId, ranges] of byMedia(cut.sources)) for (const r of ranges) {
        labels.push({ mediaId, ...r, label: cut.decision === "approved" ? "cut" : "keep", origin: `review#${cut.index}` });
      }
    }
    const decided = labels.length;
    // Applied cuts stand unless the editor undid them; keep them as labels so recall counts them.
    // A pass saved in parts cuts each part on the version the part before it left, so each maps through its own.
    // A part approved through its cut review applied only the removals the review lists, on the clock of the version it cut.
    // An older engine saved just the calls restored, numbered as planCutReview lists them, so its review is planned again.
    for (const [p, part] of (artifacts.parts ?? []).entries()) {
      const from = artifacts.timelines.get(part.fromVersion)!;
      const timeline = async (version: string) => artifacts.timelines.get(version) ?? await engine.timeline(project.id, version);
      const older = !part.appliedReview && part.restoredCuts?.length ? planCutReview(from, await timeline(part.toVersion), project.media, part.ops, part.firstCut) : undefined;
      if (older === null) warnings.push(`${part.id} was approved with cuts restored, and its review can't be planned again; all its cuts are labeled.`);
      const applied = part.appliedReview ? { original: await timeline(part.appliedReview.originalVersion), joins: part.appliedReview.joins }
        : older && { original: older.original, joins: appliedCutReview(older, part.restoredCuts!).joins };
      const removed = applied && byMedia(applied.joins.flatMap(j => timelineRangeToSource(applied.original, media, j.removed)));
      part.cutReasons?.forEach((r, i) => {
        for (const [mediaId, ranges] of byMedia(timelineRangeToSource(from, media, r))) for (const x of removed ? intersect(ranges, removed.get(mediaId) ?? []) : ranges) {
          labels.push({ mediaId, ...x, label: "cut", origin: p ? `applied#${p}.${i}` : `applied#${i}` });
        }
      });
    }
    if (!decided) warnings.push(`The editor has not approved or rejected ${review ? `review ${review.id}` : "a review"} yet; only applied cuts are labeled.`);
    const approvedVersion = artifacts.review?.state === "approved" ? artifacts.review.appliedVersion : undefined;
    if (approvedVersion && !reference) {
      writeJson(timelinePath(dir, approvedVersion), await engine.timeline(project.id, approvedVersion));
    }
    reference = {
      label: reference?.label ?? (approvedVersion ? `editor-approved version ${approvedVersion}` : `editor decisions on ${opts.fromTask}`),
      version: reference?.version ?? approvedVersion,
      labels,
    };
  }

  if (opts.publishedMedia || opts.publishedWords) {
    if (opts.referenceVersion) throw new Error("Give one reference to score against: --reference-version, or the published video.");
    const words = opts.publishedWords ?? await fetchWords(engine, opts.publishedMedia!);
    if (!words?.length) throw new Error(`${opts.publishedMedia ?? "The words file"} has no transcript words. Transcribe the published video first.`);
    const published = publishedReference(words, recordings, dialogueMedia);
    const share = published.finishedWords ? published.matchedWords / published.finishedWords : 0;
    if (share < 0.8) warnings.push(`Only ${Math.round(share * 100)}% of the published video's words were found in ${dialogueMedia.join(", ")}. Check that it was cut from this footage.`);
    console.log(`  published video: ${published.matchedWords} of ${published.finishedWords} words matched, ${Object.values(published.kept).reduce((n, r) => n + r.length, 0)} kept pieces` +
      `${published.addedPassages ? `, ${published.addedPassages} passages (${published.addedSeconds} s) in no recording` : ""}${published.rate === 1 ? "" : `, rate ${published.rate}`}`);
    if (opts.publishedVideo) {
      const files = new Map(media.flatMap(m => { const file = m.kind === "video" ? mediaFile(project.id, m) : undefined; return file ? [[m.id, file] as const] : []; }));
      let shown = 0;
      published.picture = await measurePicture(opts.publishedVideo, published.pieces, { every: opts.pictureEvery ?? 2, sync: source, files,
        progress: (done, total) => { if (done === total || done - shown >= 100) { shown = done; console.log(`  picture: ${done} of ${total} moments`); } } });
    }
    reference = { ...reference, label: opts.publishedLabel ?? "the published video", published };
  }

  // The originating run, so replay and re-scoring work offline.
  if (artifacts) {
    writeJson(join(dir, "origin", "task.json"), { task: artifacts.task, events: artifacts.events });
    writeJson(join(dir, "origin", "changes.json"), artifacts.changes);
    for (const [version, tl] of artifacts.timelines) writeJson(timelinePath(dir, version), tl);
    const context = artifacts.task.context;
    const selectionVersion = context.dialogueRange?.version ?? (!context.mediaId && context.time !== undefined ? context.version : undefined);
    if (selectionVersion && selectionVersion !== "head" && !artifacts.timelines.has(selectionVersion)) {
      writeJson(timelinePath(dir, selectionVersion), await engine.timeline(project.id, selectionVersion));
    }
  }

  const file: CaseFile = {
    schema: 1, id, suite: opts.suite ?? "capability", createdAt: new Date().toISOString(), ...(opts.notes && { notes: opts.notes }),
    projectId: project.id, fps: project.settings.fps, media, sourceVersion, dialogueMedia, request,
    ...(task && { origin: { taskId: task.id, agent: task.agent, model: task.model, effort: task.effort } }),
    ...(reference && { reference }),
  };
  writeJson(join(dir, "case.json"), file);
  return { file, dir, warnings };
}

export async function datasetCli(argv = process.argv.slice(2)) {
  const { values, positionals } = cli({
    project: { type: "string" }, "from-task": { type: "string" }, source: { type: "string" },
    "reference-version": { type: "string" }, "reference-decisions": { type: "boolean" }, "with-scan": { type: "boolean" }, fingerprint: { type: "string" },
    "published-video": { type: "string" }, "picture-every": { type: "string" },
    "published-media": { type: "string" }, "published-words": { type: "string" }, "published-label": { type: "string" },
    id: { type: "string" }, suite: { type: "string" }, instruction: { type: "string" }, skill: { type: "string" }, media: { type: "string" },
    notes: { type: "string" }, force: { type: "boolean" }, refresh: { type: "boolean" }, engine: { type: "string" },
  }, USAGE, argv);
  const command = positionals[0];
  if (command === "list") {
    const cases = listCases();
    if (!cases.length) console.log(`No cases in ${dataDir()}.`);
    for (const c of cases) {
      console.log(`${c.id} · ${c.suite} · project ${c.projectId} · source ${c.sourceVersion} · ${c.request.instruction.slice(0, 40)}` +
        `${c.reference ? ` · reference: ${c.reference.label}${c.reference.labels ? ` (${c.reference.labels.length} labels)` : ""}` : ""}`);
    }
    return;
  }
  if (command !== "build" || !values.project) throw new Error(USAGE);
  if (values.suite && values.suite !== "capability" && values.suite !== "regression") throw new Error("--suite is capability or regression.");
  const engine = await Engine.connect({ url: values.engine });
  const { file, dir, warnings } = await buildCase(engine, {
    projectId: values.project, fromTask: values["from-task"], sourceVersion: values.source,
    referenceVersion: values["reference-version"], referenceDecisions: values["reference-decisions"], withScan: values["with-scan"],
    publishedMedia: values["published-media"], publishedWords: values["published-words"] ? readJson<Word[]>(values["published-words"]) : undefined,
    publishedLabel: values["published-label"], publishedVideo: values["published-video"],
    pictureEvery: values["picture-every"] ? Number(values["picture-every"]) : undefined,
    fingerprint: values.fingerprint, id: values.id, suite: values.suite as Suite | undefined, instruction: values.instruction,
    skills: list(values.skill), mediaId: values.media, notes: values.notes, force: values.force, refresh: values.refresh,
  });
  for (const w of warnings) console.warn(`warning: ${w}`);
  console.log(`Case ${file.id} (${file.suite}): source ${file.sourceVersion}, dialogue ${file.dialogueMedia.join(", ")}, ` +
    `request ${JSON.stringify(file.request)}${file.reference ? `, reference ${file.reference.label}` : ""}.\nWrote ${dir}`);
}

if (isMain(import.meta.url)) void main(() => datasetCli());
