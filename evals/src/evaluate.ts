/** Gather a finished task's artifacts from the engine (read-only) and score them. */
import type { Change, MediaAsset, Timeline } from "../../packages/timeline/src/index.ts";
import type { LoadedCase } from "./case.ts";
import { reviewDecisions, reviewExport } from "./decisions.ts";
import type { Engine, ReviewChangeExport, TaskRecord } from "./engine.ts";
import { mediaEvidence, type StoredEvidence } from "./evidence.ts";
import { DEFAULT_EDGE_OPTIONS, submittedPlans, toolName, type EdgeOptions, type EventLike, type LabeledRange, type MediaEvidence, type SubmittedPlan } from "./metrics.ts";
import { scoreRun, type Score } from "./score.ts";
import { audibleMediaIds, type MediaInfo } from "./timeline.ts";

export interface Artifacts {
  task: TaskRecord;
  events: EventLike[];
  projectId: string;
  fps: number;
  media: MediaInfo[];
  changes: Change[];
  applied?: Change;
  /** Every applied part in order; the first is `applied`. */
  parts?: Change[];
  review?: Change;
  plan?: SubmittedPlan;
  /** Every part's plan, the first being `plan`. */
  plans?: SubmittedPlan[];
  reviewExport?: ReviewChangeExport;
  reviewSource: "engine" | "local" | "none";
  versions: { source: string; applied: string; proposed: string };
  timelines: Map<string, Timeline>;
}

export const mediaInfo = (m: { id: string; kind: string; name?: string; duration?: number; hasAudio?: boolean; hash?: string; path?: string }): MediaInfo =>
  ({ id: m.id, kind: m.kind, name: m.name, duration: m.duration, hasAudio: m.hasAudio, hash: m.hash, path: m.path });

const isDialogueApply = (c: Change) => c.intent === "requested" && !!c.cutReasons?.length;

type Decide = (review: Change, timeline: (v: string) => Promise<Timeline>) => Promise<{ source: "engine" | "local"; changes: ReviewChangeExport[] }>;

async function assemble(task: TaskRecord, events: EventLike[], changes: Change[], project: { id: string; fps: number; media: MediaInfo[] },
  load: (v: string) => Promise<Timeline>, decide: Decide): Promise<Artifacts> {
  const applied = changes.find(isDialogueApply);
  // A run saved in parts applies a chain: each part starts where the previous one left the edit.
  const parts = applied ? [applied] : [];
  for (let next: Change | undefined; (next = changes.find(c => isDialogueApply(c) && !parts.includes(c) &&
    c.fromVersion === (parts.at(-1)!.appliedVersion ?? parts.at(-1)!.toVersion)));) parts.push(next);
  const review = changes.filter(c => c.intent === "suggestion" && c.ops?.length)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")).at(-1);
  const submitted = submittedPlans(events);
  const source = applied?.fromVersion ?? submitted.at(-1)?.version ?? review?.fromVersion ?? task.context.version;
  if (!source) throw new Error(`Task ${task.id} produced no dialogue cut to evaluate and names no source version.`);
  // The last submission on each version of the chain is the plan that version's part applied.
  const chain = [source, ...parts.map(p => p.appliedVersion ?? p.toVersion)];
  const plans = chain.flatMap(v => submitted.filter(p => p.version === v).slice(-1));
  if (!plans.length && submitted.length) plans.push(submitted.at(-1)!);
  const plan = plans[0];
  const last = parts.at(-1);
  const appliedVersion = last ? last.appliedVersion ?? last.toVersion : source;
  const proposed = review?.toVersion ?? appliedVersion;
  const timelines = new Map<string, Timeline>();
  const timeline = async (v: string) => {
    const tl = timelines.get(v) ?? await load(v);
    timelines.set(v, tl);
    return tl;
  };
  for (const v of new Set([source, appliedVersion, proposed, review?.fromVersion, ...chain, ...plans.map(p => p.version)].filter((v): v is string => !!v))) await timeline(v);
  // Versions the run checked joins on, to compare those checks with later parts. A case may not store them.
  const checked = events.flatMap(e => e.type === "tool" && toolName(String(e.data?.tool ?? "")) === "dialogue_check_join"
    && typeof (e.data?.input as { version?: unknown } | undefined)?.version === "string" ? [(e.data!.input as { version: string }).version] : []);
  for (const v of new Set(checked)) if (!timelines.has(v)) await timeline(v).catch(() => undefined);
  let reviewExport: ReviewChangeExport | undefined, reviewSource: Artifacts["reviewSource"] = "none";
  if (review) {
    const result = await decide(review, timeline);
    reviewExport = result.changes.find(c => c.id === review.id);
    reviewSource = reviewExport ? result.source : "none";
  }
  return { task, events, projectId: project.id, fps: project.fps, media: project.media, changes, applied, parts, review, plan, plans, reviewExport, reviewSource,
    versions: { source, applied: appliedVersion, proposed }, timelines };
}

/** Everything a finished task produced, read from the engine. */
export async function gatherTask(engine: Engine, taskId: string, cached?: (v: string) => Timeline | undefined): Promise<Artifacts> {
  const { task: record, events } = await engine.task(taskId);
  const usage = await engine.taskUsage(record.projectId, taskId);
  const task = usage ? { ...record, usage } : record;
  const project = await engine.project(task.projectId);
  const changes = await Promise.all(task.changeIds.map(id => engine.change(id)));
  return assemble(task, events, changes, { id: project.id, fps: project.settings.fps, media: project.media.map(mediaInfo) },
    async v => cached?.(v) ?? engine.timeline(task.projectId, v),
    (review, timeline) => reviewDecisions(engine, task.projectId, [review], timeline, project.media, taskId));
}

/** The run a case was built from, entirely from the case folder. */
export async function artifactsFromCase(loaded: LoadedCase): Promise<Artifacts> {
  const origin = loaded.origin();
  if (!origin) throw new Error(`Case ${loaded.file.id} was not built with --from-task; it has no stored run.`);
  const load = async (v: string) => {
    const tl = loaded.timeline(v);
    if (!tl) throw new Error(`Case ${loaded.file.id} is missing timeline ${v}. Rebuild it with --force.`);
    return tl;
  };
  const media = loaded.file.media as unknown as MediaAsset[];
  return assemble(origin.task, origin.events, origin.changes, { id: loaded.file.projectId, fps: loaded.file.fps, media: loaded.file.media }, load,
    async (review, timeline) => {
      const item = reviewExport(review, await timeline(review.fromVersion), await timeline(review.toVersion), media);
      return { source: "local", changes: item ? [item] : [] };
    });
}

export interface Evaluation {
  schema: 1;
  kind: "task";
  generatedAt: string;
  taskId: string;
  projectId: string;
  caseId?: string;
  config: { agent?: string; model?: string; effort?: string };
  instruction: string;
  reviewDecisionsFrom: Artifacts["reviewSource"];
  evidence: Array<{ mediaId: string; words: number; levels?: string }>;
  edgeOptions: EdgeOptions;
  score: Score;
}

export interface EvaluateOptions {
  loaded?: LoadedCase;
  referenceVersion?: string;
  edgeOptions?: EdgeOptions;
  refreshEvidence?: boolean;
}

export async function evaluateTask(engine: Engine, taskId: string, opts: EvaluateOptions = {}): Promise<Evaluation> {
  const a = await gatherTask(engine, taskId, opts.loaded?.timeline);
  const evidence = new Map<string, MediaEvidence>();
  for (const id of audibleMediaIds(a.timelines.get(a.versions.source)!, a.media)) {
    evidence.set(id, opts.loaded?.evidence.get(id) ?? await mediaEvidence(engine, a.projectId, a.media.find(m => m.id === id)!, opts.refreshEvidence));
  }
  let reference: ReferenceInput | undefined;
  if (opts.referenceVersion) {
    reference = { label: `version ${opts.referenceVersion}`, timeline: await engine.timeline(a.projectId, opts.referenceVersion) };
  } else if (opts.loaded?.file.reference) {
    const r = opts.loaded.file.reference;
    reference = { label: r.label, timeline: r.version ? opts.loaded.timeline(r.version) ?? await engine.timeline(a.projectId, r.version) : undefined, labels: r.labels, published: r.published };
  }
  return evaluateArtifacts(a, evidence, reference, opts);
}

/** Re-score the run stored in a case, offline. */
export async function evaluateCaseOrigin(loaded: LoadedCase, opts: Omit<EvaluateOptions, "loaded" | "referenceVersion"> = {}): Promise<Evaluation> {
  const a = await artifactsFromCase(loaded);
  const r = loaded.file.reference;
  const reference = r && { label: r.label, timeline: r.version ? loaded.timeline(r.version) : undefined, labels: r.labels, published: r.published };
  return evaluateArtifacts(a, loaded.evidence, reference, { ...opts, loaded });
}

type ReferenceInput = NonNullable<Parameters<typeof scoreRun>[0]["reference"]>;

export function evaluateArtifacts(a: Artifacts, evidence: ReadonlyMap<string, MediaEvidence>, reference: ReferenceInput | undefined, opts: EvaluateOptions = {}): Evaluation {
  const edgeOptions = opts.edgeOptions ?? DEFAULT_EDGE_OPTIONS;
  const score = scoreRun({
    media: a.media,
    timelines: { source: a.timelines.get(a.versions.source)!, applied: a.timelines.get(a.versions.applied)!, proposed: a.timelines.get(a.versions.proposed)!,
      reviewBase: a.review ? a.timelines.get(a.review.fromVersion) : undefined, plan: a.plan ? a.timelines.get(a.plan.version) : undefined },
    appliedChange: a.applied, reviewChange: a.review, review: a.reviewExport, plan: a.plan,
    appliedParts: a.parts?.map(change => ({ change, from: a.timelines.get(change.fromVersion)! })),
    plans: a.plans?.map(plan => ({ plan, timeline: a.timelines.get(plan.version)! })),
    timelineAt: v => a.timelines.get(v),
    evidence, reference, task: a.task, events: a.events, edgeOptions,
  });
  return {
    schema: 1, kind: "task", generatedAt: new Date().toISOString(), taskId: a.task.id, projectId: a.projectId, caseId: opts.loaded?.file.id,
    config: { agent: a.task.agent, model: a.task.model, effort: a.task.effort },
    instruction: String(a.task.context.message ?? a.task.instruction).slice(0, 500),
    reviewDecisionsFrom: a.reviewSource,
    evidence: [...evidence.values()].map(e => ({ mediaId: e.mediaId, words: e.words?.length ?? 0,
      levels: e.levels ? (e as StoredEvidence).levelSource ?? `${Math.round(e.levels.step * 1000)} ms` : undefined })),
    edgeOptions, score,
  };
}
