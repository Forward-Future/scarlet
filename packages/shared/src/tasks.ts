/** Requests: what the editor asked and pointed at, how a run of it went, and what a host is told and reports. */
import { z } from "zod/v3";
import { Author, Id, LocalTranscriptionModel, Seconds, TimeRange } from "@scarlet/timeline";
import { AgentEffort, AgentId, AgentOptionId } from "./agents.js";
import { SkillSlug } from "./skills.js";

/** A stretch of the timeline the editor marked on its ruler, in seconds on `version`, or of `mediaId`'s own footage. */
export const MarkedRange = z.object({ version: Id.optional(), mediaId: Id.optional(), start: Seconds, end: Seconds });
export type MarkedRange = z.infer<typeof MarkedRange>;
/**
 * The frame the editor paused the video on while writing to a cut or an edit, in seconds on `version` (or of `mediaId`'s
 * own footage): the timeline the player showed, not necessarily the edit's.
 */
export const MessageTime = z.object({ version: Id.optional(), mediaId: Id.optional(), time: Seconds });
export type MessageTime = z.infer<typeof MessageTime>;

/** A point on the picture, as fractions of the frame's width and height from its top left. */
const FramePoint = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
export const PictureMarkKind = z.enum(["draw", "box", "point"]);
export type PictureMarkKind = z.infer<typeof PictureMarkKind>;
/** A mark the editor drew on the picture: a freehand line, a box or a point, in fractions of the frame. */
export const PictureMark = z.object({
  kind: PictureMarkKind,
  /** The stretch of the frame it covers. A point's is its spot. */
  box: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }),
  /** A freehand line's path, thinned. */
  points: z.array(FramePoint).max(200).optional(),
});
export type PictureMark = z.infer<typeof PictureMark>;
/** Marks the editor drew on one frame for a request, and the picture of that frame with them drawn on it. */
export const PictureMarks = z.object({
  /** The picture of the frame with the marks on it, an attachment of the same request. */
  attachmentId: Id,
  time: Seconds,
  version: Id.optional(),
  mediaId: Id.optional(),
  marks: z.array(PictureMark).min(1).max(20),
});
export type PictureMarks = z.infer<typeof PictureMarks>;

export const TaskKind = z.enum([
  "edit", // free-form instruction against the project ("make the first cut as a 9:16 short")
  "note", // respond to a specific review note
  "revise", // revise a rejected/sent-back change
  "skill_from_change", // write a SKILL.md capturing an approved change
  "skill_edit", // revise one skill as the editor described; not part of a project's conversation
  "learning_check", // read one request for a standing rule to offer; started with the request, beside it
  "area_check", // look at one frame of a recording and say what of it viewers may see; started when a save needs it
  "listen_check", // hear one passage of a recording and say what it heard, for a request whose model can't hear; started by its `listen` call
  "hand_off", // do one kind of work for a request with the model the editor chose for it in Task models; started by its `hand_off` call, its edits join that request
  "broll_make", // retired 2026-11-21: a run beside a request that made one piece of B-roll. Every request has the shell and the web now. Kept so saved tasks still read.
  "transcribe", // server-side job, not dispatched to hosts
]);
export type TaskKind = z.infer<typeof TaskKind>;

/** Requests that edit the project's video, including requests about a note or an existing edit. */
export const PROJECT_EDIT_TASK_KINDS: readonly TaskKind[] = ["edit", "note", "revise"];

export function isProjectEditTask(task: { kind: TaskKind }): boolean {
  return PROJECT_EDIT_TASK_KINDS.includes(task.kind);
}

export const TaskState = z.enum([
  "queued",
  "claimed",
  "running",
  "waiting_for_user", // agent asked a question
  "done",
  "failed",
  "cancelled",
]);
export type TaskState = z.infer<typeof TaskState>;

/** A file the editor attached to a message, stored in the project's folder until the project is deleted. */
export const TaskAttachment = z.object({
  id: Id,
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  mime: z.string().max(200).optional(),
});
export type TaskAttachment = z.infer<typeof TaskAttachment>;

export const Task = z.object({
  id: Id,
  projectId: Id,
  kind: TaskKind,
  /** Which agent runtime should run it. */
  agent: AgentId,
  model: z.string().optional(),
  effort: AgentEffort.optional(),
  /** Fast mode: quicker output, uses more of the plan (Claude fast mode, Codex fast tier). */
  fast: z.boolean().optional(),
  serviceTier: AgentOptionId.optional(),
  /** Plain-language instruction, already cleaned up from voice. */
  instruction: z.string(),
  /** Extra structured context the host passes to the agent. */
  context: z
    .object({
      branch: z.string().optional(),
      /** Include the transcript actually read by editing tools in this evaluation task's evidence. */
      recordTranscriptDigests: z.boolean().optional(),
      version: Id.optional(),
      mediaId: Id.optional(),
      /** The provider the editor chose for this one transcription, when it isn't the one in Settings. */
      transcriptionProvider: z.string().max(40).optional(),
      /** The service a transcription ran with, so a run cut off by a quit starts again by itself only with that service. */
      transcribedWith: z.string().max(40).optional(),
      /** The local engine that ran, when this was a configured local transcription. */
      localModel: LocalTranscriptionModel.optional(),
      noteIds: z.array(Id).optional(),
      changeId: Id.optional(),
      cutIndex: z.number().int().nonnegative().optional(),
      editIndex: z.number().int().nonnegative().optional(),
      /** The selected edit's number in the editor's list, which is how they and Scarlet's replies refer to it. */
      editNumber: z.number().int().positive().optional(),
      /**
       * The other edits in the moment the editor's words are about, when they were looking at a moment of the list and
       * not one edit: edits whose stretches overlap and play as one change. `time` and `end` span the whole moment.
       */
      momentEdits: z.array(z.object({ changeId: Id, spot: z.number().int().nonnegative(), label: z.string().max(400).optional() })).max(50).optional(),
      /** Slug authorized by the editor when requesting a skill from an approved change. */
      skillName: SkillSlug.optional(),
      /** The skill the editor asked Scarlet to revise. */
      skillId: Id.optional(),
      /** The learning this skill edit saves, when the editor approved one. */
      learningId: Id.optional(),
      /** The request a learning_check task reads. A rule it offers is that request's. */
      checksTaskId: Id.optional(),
      /** A learning_check started as the editor finished deciding what that request left them, to read their decisions. */
      readsDecisions: z.literal(true).optional(),
      /** The frame an area_check task looks at: a recording and a source second. */
      areaCheck: z.object({ mediaId: Id, at: Seconds }).optional(),
      /** The passage a listen_check task hears, in source seconds, and what the request that asked wants to know of it. */
      listenCheck: z.object({ mediaId: Id, from: Seconds, to: Seconds, voice: z.enum(["me", "other voices"]).optional(), question: z.string().min(1).max(2000) }).optional(),
      /**
       * The kind of work a hand_off task does for the request in `checksTaskId`, as the editor named it in Task models,
       * and what the model running that request asked of it.
       */
      handOff: z.object({ typeId: z.string().max(40), name: z.string().max(40), description: z.string().max(300).optional(), brief: z.string().min(1).max(8000) }).optional(),
      time: Seconds.optional(),
      end: Seconds.optional(),
      clipIds: z.array(Id).optional(),
      /** A stretch the editor marked on the timeline for this request. `time` and `end` stay those of the cut or edit it is about. */
      markedRange: MarkedRange.optional(),
      /** The frame the editor paused on while writing to the cut or edit `time` is about. */
      messageTime: MessageTime.optional(),
      reviewAllCuts: z.boolean().optional(),
      /** Product shortcut chosen by the editor, independent of the guides pinned to this task. */
      dialogueOperation: z.enum(["none", "first-cut", "local-pauses"]).optional(),
      /** The local passage established on the first save, in this immutable version's timeline seconds. */
      dialogueRange: z.object({ version: Id, start: Seconds, end: Seconds }).optional(),
      skillIds: z.array(Id).optional(),
      /** The thread this task belongs to. Defaults to the task's own id (a new thread). */
      threadId: Id.optional(),
      /**
       * What the person actually said, when `instruction` was expanded with thread history. For a request the app
       * worded for them, such as Undo edit, it is the request's name in the chat ("Undo").
       */
      message: z.string().optional(),
      /** Files the editor attached to this message. The engine gives the agent their paths. */
      attachments: z.array(TaskAttachment).max(20).optional(),
      /** Marks the editor drew on the picture for this message. Their picture is one of its attachments. */
      pictureMarks: PictureMarks.optional(),
      /** What such a request asked of the agent, without the thread's history. Its name alone doesn't say which edit, so the thread's later requests are told this. */
      asked: z.string().optional(),
    })
    .default({}),
  state: TaskState,
  createdBy: Author,
  hostId: Id.nullable().default(null),
  /** The skill a skill_from_change task produced, or a skill_edit task revised. */
  resultSkillId: Id.optional(),
  /**
   * What the pass's latest repeat check measured, on the version it read: evidence kept with the request for the window
   * and the evals. It holds nothing open: a pass that says it is done is done (2026-11-21).
   */
  repeatAudit: z.object({
    version: z.string(),
    /** The repeats, restarts, long silences, divided sentences and pictures the check listed that the pass hadn't cut, changed, kept or staged. */
    remaining: z.number().int().nonnegative().optional(),
    /** Every audible passage in scope was checked and there were no repeats or joins to review. */
    noFindings: z.boolean().optional(),
    unavailable: z.array(z.string()).optional(),
    /**
     * How many times an engine before 2026-11-21 sent the pass back to work for a closing check on this version, and in
     * all (`totalReturns`), and when it last did (`queuedAt`). None does now; kept on the passes stored with them.
     */
    returns: z.number().int().nonnegative().default(0),
    totalReturns: z.number().int().nonnegative().optional(),
    queuedAt: z.string().datetime().optional(),
    /** The pass had finished and the closing check an earlier engine sent it back for couldn't run: why. */
    failed: z.string().optional(),
  }).optional(),
  /** Change(s) produced. */
  changeIds: z.array(Id).default([]),
  /** Median running time of recent comparable completed requests, when available. */
  expectedSeconds: z.number().positive().optional(),
  /** A running transcription: waiting its turn behind other audio work, or how much is done. */
  progress: z.object({
    stage: z.enum(["queued", "transcribing", "aligning"]),
    fraction: z.number().min(0).max(1),
    remainingSeconds: z.number().nonnegative().optional(),
    /**
     * The same for the words alone. The transcript is saved once it has them, before word alignment, and a dialogue
     * pass reads it from then on, so this is the part of the job a pass waits for.
     */
    words: z.object({ fraction: z.number().min(0).max(1), remainingSeconds: z.number().nonnegative().optional() }).optional(),
  }).optional(),
  /** The worker stopped before finishing, possibly after saving changes. */
  interrupted: z.boolean().optional(),
  /** The run's worker went missing while Scarlet stayed open. A quit doesn't count: only these limit how often a run carries on by itself. */
  lostWorker: z.boolean().optional(),
  /**
   * A finished run waited for these recordings' transcripts or dialogue analysis and ended before they were ready,
   * so it saved only what it could do without them. Scarlet measures this from the run's waits; it can be resumed.
   */
  needsTranscripts: z.array(Id).optional(),
  /** The editor asked Scarlet to resume this run as soon as `needsTranscripts` are ready. */
  continueWhenReady: z.boolean().optional(),
  retryTaskId: Id.optional(),
  /** Server-assigned original attempt whose workspace and progress this run continues. */
  resumeRootId: Id.optional(),
  /** Insertion order from the engine, used to break ties between requests saved in the same millisecond. */
  queueSequence: z.number().int().optional(),
  /** This attempt was put back in line by the project's Stop control. It takes priority over waiting requests. */
  resumesAfterProjectStop: z.boolean().optional(),
  /** Whether the selected cut was still staged when the request was made. Editing an applied cut uses the timeline. */
  stagedCutRevision: z.boolean().optional(),
  /**
   * The editor is changing this queued request's words. No host claims it until then, and the requests behind it keep
   * waiting, so it can't start with the words being replaced. The app renews it while the words are open.
   */
  rewordingUntil: z.string().datetime().optional(),
  /**
   * The editor told this queued request to start without waiting for their calls on a dialogue pass. It still takes
   * its turn behind what Scarlet is on and what is ahead of it in line.
   */
  startsBeforeCalls: z.boolean().optional(),
  /** The CLI session that asked the pending question; the host resumes it with the answer. */
  session: z.object({ agent: AgentId, id: z.string().min(1) }).optional(),
  /**
   * This attempt's CLI session carries on in the attempt that resumes it (`retryTaskId`), as after a quit or a pause of
   * the project's editing. The host keeps the session's files when the run ends; a run the editor stopped has none.
   */
  sessionCarriesOn: z.boolean().optional(),
  /** Attempt `startedAt` whose CLI session was discarded (a model switch on an answer), so that host's late callbacks can't attach it again. */
  sessionRevokedFor: z.string().datetime().optional(),
  /** Pending question from the agent, if waiting_for_user. */
  question: z.string().nullable().default(null),
  /** The short answers Scarlet offered with that question, when it has a few clear ones: one press sends one. */
  questionChoices: z.array(z.string()).optional(),
  /** Where the editor can hear the updated passage while answering a question about a staged cut. */
  cutConflict: z.object({ version: Id, range: TimeRange.optional(), changeId: Id.optional(), index: z.number().int().nonnegative().optional(),
    answered: z.literal(true).optional(), retried: z.literal(true).optional(),
    /** The editor already approved this call before the agent was asked to recheck it. */
    approved: z.literal(true).optional() }).optional(),
  summary: z.string().nullable().default(null),
  /**
   * What Scarlet said to the editor as a dialogue pass finished. The pass's `summary` is Scarlet's receipt of what it
   * saved, so its own words are kept here: those of the pass itself, not of the repeat check that follows it.
   */
  reply: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  /** Milliseconds spent working on closed claims. An active claim starts at startedAt. */
  workedMs: z.number().int().nonnegative().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});
export type Task = z.infer<typeof Task>;

/** Retrying is safe only if an editing worker failed before saving an output. */
export function canRetryTask(task: Task): boolean {
  return task.state === "failed" && task.kind !== "transcribe" && !task.changeIds.length && !task.resultSkillId;
}

/**
 * The host stopped the run before it finished, keeping what it saved. Hosts mark this as `interrupted`;
 * older ones stopped every run at 45 minutes and recorded only "timed out".
 */
export function taskWasStopped(task: Task): boolean {
  return task.state === "failed" && (!!task.interrupted || /^timed out\b/.test(task.error ?? ""));
}

/** The run ended without the transcripts it waited for, keeping what it saved. */
export function taskNeedsTranscripts(task: Task): boolean {
  return task.state === "done" && !!task.needsTranscripts?.length && !task.retryTaskId;
}

export function taskRecoveryAction(task: Task, hasLinkedChange: boolean): "resume" | "retry" | undefined {
  if (task.kind === "transcribe" || task.resultSkillId) return;
  if (task.state === "cancelled" || taskWasStopped(task) || taskNeedsTranscripts(task)) return "resume";
  if (canRetryTask(task) && !hasLinkedChange) return task.resumeRootId ? "resume" : "retry";
  // A run that failed after saving picks up where it left off, keeping what it saved.
  if (task.state === "failed") return "resume";
}

/**
 * A finished pass an engine before 2026-11-21 sent back for a closing check that couldn't run. No check is owed now and
 * no Retry runs one: the engine clears this record when it starts (`settleClosingChecks`).
 */
export function closingCheckFailed(task: Task): boolean {
  return task.state === "done" && !!task.repeatAudit?.failed;
}

/** The editor-selected destination available to a live skill authoring task. */
export function skillTaskTarget(task: Task, projectId: string) {
  if (task.kind !== "skill_from_change" || task.projectId !== projectId || !task.hostId ||
      (task.state !== "claimed" && task.state !== "running") || !task.context.changeId || !task.context.skillName) return undefined;
  return { name: task.context.skillName, changeId: task.context.changeId, hostId: task.hostId };
}

/** The one skill a live skill-edit task may revise: the one the editor asked about. */
export function skillEditTarget(task: Task, projectId: string) {
  if (task.kind !== "skill_edit" || task.projectId !== projectId || !task.hostId ||
      (task.state !== "claimed" && task.state !== "running") || !task.context.skillId) return undefined;
  return { skillId: task.context.skillId, hostId: task.hostId };
}

/** A request to revise a skill. It isn't about the project it runs in. */
export function isSkillEdit(task: Pick<Task, "kind">): boolean {
  return task.kind === "skill_edit";
}

/** The check that reads a request for a standing rule. It runs beside the request and edits nothing. */
export function isLearningCheck(task: Pick<Task, "kind">): boolean {
  return task.kind === "learning_check";
}

/** The look at one frame for what viewers may see. It runs beside the request that needs it and edits no video. */
export function isAreaCheck(task: Pick<Task, "kind">): boolean {
  return task.kind === "area_check";
}

/** A run that hears one passage for a request whose own model can't hear, and says what it heard. */
export function isListenCheck(task: Pick<Task, "kind">): boolean {
  return task.kind === "listen_check";
}

/** A retired kind of run, which made one piece of B-roll beside a request. One saved earlier stays out of the conversation. */
export function isBrollMake(task: Pick<Task, "kind">): boolean {
  return task.kind === "broll_make";
}

/**
 * A run that does one kind of work for a request with the model the editor chose for it in Task models. It edits the
 * video, but as part of the request that handed it the work: its edits are that request's, so it stays out of the
 * conversation and the queue like a check, and runs while that request waits on it.
 */
export function isHandOff(task: Pick<Task, "kind">): boolean {
  return task.kind === "hand_off";
}

/**
 * A run that stays out of the project's conversation and queue: one that edits no video (a skill edit, a learning
 * check, an area check or a listen check), or a hand-off, whose edits are the request's that handed it the work.
 */
export function isAsideTask(task: Pick<Task, "kind">): boolean {
  return isSkillEdit(task) || isLearningCheck(task) || isAreaCheck(task) || isListenCheck(task) || isBrollMake(task) || isHandOff(task);
}

/**
 * A run beside a request that the request waits on, and that saves nothing to the video of its own: a learning check,
 * an area check, a listen check, or a hand-off, whose edits join the request. A host runs these in slots of their own,
 * so they never wait behind the requests they serve. A running edit waits on its area checks and its hand-offs, and
 * sharing its slots left it holding one while its checks queued for the rest (20 checks on 2 slots took 12 minutes,
 * 2026-11-20). A skill edit rewrites a skill and isn't one.
 */
export function isSideCheck(task: Pick<Task, "kind">): boolean {
  return isLearningCheck(task) || isAreaCheck(task) || isListenCheck(task) || isHandOff(task);
}

/** The kinds `isSideCheck` names, for the engine's claim query. */
export const SIDE_CHECK_KINDS = ["learning_check", "area_check", "listen_check", "hand_off"] as const satisfies readonly TaskKind[];

/**
 * Side checks a host runs at once per runtime, beside its `maxParallel` requests: twice as many, up to 12. Each looks at
 * one frame or reads one request, so it is short; a host set to run fewer requests (a smaller machine) runs fewer.
 * The desktop host repeats this (`side_check_slots` in apps/desktop/src-tauri/src/host/mod.rs).
 */
export function sideCheckSlots(maxParallel: number): number {
  return Math.min(12, 2 * Math.max(1, maxParallel));
}

export const TaskSkillDraft = z.object({
  description: z.string().trim().min(1).max(1024).regex(/^[^\r\n]+$/),
  instructions: z.string().trim().min(1).max(128 * 1024),
});
export type TaskSkillDraft = z.infer<typeof TaskSkillDraft>;

export const CreateTaskRequest = z.object({
  kind: TaskKind.default("edit"),
  agent: AgentId,
  model: z.string().optional(),
  effort: AgentEffort.optional(),
  fast: z.boolean().optional(),
  serviceTier: AgentOptionId.optional(),
  instruction: z.string().min(1),
  voiceTranscript: z.string().optional(),
  context: Task.shape.context.removeDefault().omit({ dialogueOperation: true, dialogueRange: true }).optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

/**
 * New words for a request still waiting its turn, and the skills their /commands name, resolved as a send resolves
 * them. The skills replace the request's: words that no longer name a skill don't run it.
 */
export const RewordTaskRequest = z.object({
  text: z.string().trim().min(1),
  skillIds: z.array(Id).optional(),
});
export type RewordTaskRequest = z.infer<typeof RewordTaskRequest>;

/** Source seconds in a dialogue scan. A page has no "to" until the scanner finishes it. */
export const DialogueScanPage = z.object({
  mediaId: Id,
  from: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  to: z.number().finite().optional(),
}).refine(p => p.from < p.end && (p.to === undefined || (p.to > p.from && p.to <= p.end)));
export type DialogueScanPage = z.infer<typeof DialogueScanPage>;

/** The answers a question can offer the editor to pick with one press: two to four, each a few words. */
export const QuestionChoices = z.array(z.string().trim().min(1).max(80)).min(2).max(4);

/** The answers a `question` event offered, when it offered a well-formed set. */
export function questionChoicesOf(data: Record<string, unknown> | undefined): string[] | undefined {
  const parsed = QuestionChoices.safeParse(data?.choices);
  return parsed.success ? parsed.data : undefined;
}

export const TaskEvent = z.object({
  id: Id.optional(),
  taskId: Id.optional(),
  at: z.string().datetime().optional(),
  type: z.enum([
    "log", // agent stdout line / progress message
    "tool", // agent called a Scarlet tool
    "question", // agent needs input → task enters waiting_for_user
    "answer", // human answered
    "change", // a change was proposed
    "plan", // the agent's own to-do list, as its harness reported it: data is a TaskPlan
    "error",
  ]),
  text: z.string(),
  data: z.record(z.unknown()).optional(),
});
export type TaskEvent = z.infer<typeof TaskEvent>;

/**
 * One step of the plan an agent keeps for itself, in its own words. `state` is what the harness said and nothing
 * more: Codex's headless stream marks a step finished or not, so its steps are never "in_progress".
 */
export const PlanStep = z.object({ text: z.string().trim().min(1), state: z.enum(["pending", "in_progress", "done"]) });
export type PlanStep = z.infer<typeof PlanStep>;

/**
 * A `plan` event's data: every step of the agent's plan as it stood when the harness reported it (Claude Code's task
 * tools, Codex's `update_plan`). Scarlet asks for one where the harness has the tool and the chat will show it, sets none of its steps and never edits it. No steps means the agent cleared it.
 */
export const TaskPlan = z.object({ steps: z.array(PlanStep).max(100) });
export type TaskPlan = z.infer<typeof TaskPlan>;

/** How a plan reads as an event's text, in logs and exports: one step a line, "[x]" done, "[>]" under way, "[ ]" to come. */
export function planText(steps: readonly PlanStep[]): string {
  return steps.map(step => `${step.state === "done" ? "[x]" : step.state === "in_progress" ? "[>]" : "[ ]"} ${step.text}`).join("\n") || "Plan cleared";
}

/**
 * The plan a run is working to: the last one its harness reported. A run picked up again after the editor's answer
 * starts without one, because nothing says the harness still keeps the plan it had before the question.
 */
export function taskPlan(events: readonly Pick<TaskEvent, "type" | "data">[]): PlanStep[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "answer") return undefined;
    if (event.type !== "plan") continue;
    const plan = TaskPlan.safeParse(event.data);
    return plan.success && plan.data.steps.length ? plan.data.steps : undefined;
  }
  return undefined;
}

export const CompleteTaskRequest = z.object({
  state: z.enum(["done", "failed", "cancelled"]),
  /** Only finish this still-active claim. A newer claim or an editor answer wins. */
  ifStartedAt: z.string().datetime().optional(),
  interrupted: z.boolean().optional(),
  /** The run stopped because its engine went away, and a host started for the next engine reports it. It counts as a
   * lost worker: a run whose own work keeps crashing the engine stops resuming by itself. */
  engineLost: z.boolean().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  changeIds: z.array(Id).optional(),
});
export type CompleteTaskRequest = z.infer<typeof CompleteTaskRequest>;

/** The one prompt every host gives its CLI, built by the engine. */
export const TaskPrompt = z.object({
  systemPrompt: z.string(),
  instruction: z.string(),
  /** Continue this CLI session with `instruction` (the editor's answer). Absent: start a fresh run. */
  resumeSession: z.string().optional(),
  /** Launch the CLI with its own to-do tool on, so the plan it keeps reaches Scarlet (`plan` in capabilities.ts). */
  plan: z.boolean().optional(),
  /**
   * What the host tells the model after refusing it a tool that isn't Scarlet's, with `{tool}` standing for the tool's
   * name. A host given none says it in its own words.
   */
  refusedTool: z.string().optional(),
  /**
   * Launch the CLI with its harness's own shell, file and web tools beside Scarlet's, the shell sandboxed to the task
   * folder (`workspaceCapabilities` in capabilities.ts). Every request has them, and what to use them for is the
   * model's call (the editor's decision, 2026-11-21: no rule in Scarlet's code picks which run gets them). A side check
   * and a skill's revision, which edit no video, don't. Absent, the host offers Scarlet's tools only.
   */
  workspace: z.boolean().optional(),
});
export type TaskPrompt = z.infer<typeof TaskPrompt>;
