/**
 * Task models: kinds of work the editor gives to a model of their choosing (Settings → Models). The model running a
 * request hands a piece of such work to that model with `hand_off`: a run of its own (a hand_off task), beside the
 * request and outside the project's queue, whose edits join the request. The request waits for it and hears back what
 * it saved and said.
 */
import { isProjectEditTask, taskModelChoice, type AgentId, type HandOffResult, type Task, type TaskModelType } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { badRequest } from "../errors.js";
import { threadOf } from "./changes/common.js";
import { handedOffBy } from "./handOffScope.js";
import { FINISHED_TASK, createTask } from "./tasks.js";

/** How long since a host's last heartbeat it still counts as online (`ONLINE_WINDOW_MS` in routes/hosts.ts). */
const HOST_ONLINE_MS = 90_000;

type By = { agent: string; model?: string; label?: string };

const onlineHosts = (ctx: Ctx) => ctx.repos.hosts.select().filter(h => h.lastSeenAt && Date.now() - Date.parse(h.lastSeenAt) < HOST_ONLINE_MS);

/** Whether a host the editor has online has this model signed in. */
function signedIn(ctx: Ctx, by: By): boolean {
  return onlineHosts(ctx).some(h => h.agents.some(a => a.id === by.agent && a.installed && a.loggedIn !== false
    && (!by.model || a.model === by.model || !!a.models?.includes(by.model))));
}

/** The model with the name its host gives it ("Gemini 3 Pro"), so the chat and the model running a request say it as the editor reads it. */
function named(ctx: Ctx, by: By): By {
  const label = onlineHosts(ctx).flatMap(h => h.agents).find(a => a.id === by.agent && a.modelLabels?.[by.model ?? ""])?.modelLabels?.[by.model ?? ""];
  return label ? { ...by, label } : by;
}

const sameModel = (task: Pick<Task, "agent" | "model">, by: By) => task.agent === by.agent && (task.model ?? "") === (by.model ?? "");

/**
 * The kinds of work this request hands off: those the editor gave a model other than the request's own, signed in on a
 * host that is online. A request of any other kind, and a hand-off itself, hands off nothing.
 */
export function handOffTypes(ctx: Ctx, task: Task): Array<TaskModelType & { by: By }> {
  if (!isProjectEditTask(task)) return [];
  return ctx.settings().taskModels.flatMap(type => {
    const by = taskModelChoice(type);
    return by && !sameModel(task, by) && signedIn(ctx, by) ? [{ ...type, by: named(ctx, by) }] : [];
  });
}

/** The position, files and skills of the request a hand-off works for, so it is told what the request was told. */
function sharedContext(asker: Task): Task["context"] {
  const c = asker.context;
  return {
    ...(c.version && { version: c.version }), ...(c.mediaId && { mediaId: c.mediaId }), ...(c.time !== undefined && { time: c.time }),
    ...(c.end !== undefined && { end: c.end }), ...(c.clipIds && { clipIds: c.clipIds }), ...(c.markedRange && { markedRange: c.markedRange }),
    ...(c.messageTime && { messageTime: c.messageTime }), ...(c.attachments && { attachments: c.attachments }),
    ...(c.pictureMarks && { pictureMarks: c.pictureMarks }), ...(c.skillIds && { skillIds: c.skillIds }),
    ...(c.dialogueOperation && { dialogueOperation: c.dialogueOperation }), ...(c.branch && { branch: c.branch }),
    ...(c.message && { message: c.message }),
  };
}

export interface HandOffAsk {
  /** The kind of work, by its id or its name in Task models. */
  type?: string;
  /** What the request asks of the model that does it. */
  brief?: string;
  /** A hand-off this request already started, to wait for. */
  handoffId?: string;
}

/**
 * Hand a piece of a request's work to the model the editor chose for that kind of work, and wait up to `waitMs` for
 * what it saved and said. Asked again with the same kind and brief, the request waits on the run already at work or
 * hears what it said; with `handoffId`, it waits on that one.
 */
export async function handOff(ctx: Ctx, askerId: string, ask: HandOffAsk, waitMs: number): Promise<HandOffResult> {
  const asker = ctx.repos.tasks.get(askerId);
  if (!asker || !isProjectEditTask(asker)) throw badRequest("invalid_task", "Only a request that edits the video can hand work off.");
  const mine = () => ctx.repos.tasks.select("project_id = ? AND kind = 'hand_off' AND json_extract(json, '$.context.checksTaskId') = ?",
    [asker.projectId, asker.id], "created_at DESC, rowid DESC");
  let run: Task | undefined;
  if (ask.handoffId) {
    run = mine().find(t => t.id === ask.handoffId);
    if (!run) throw badRequest("invalid_hand_off", `${ask.handoffId} isn't a hand-off of this request.`);
  } else {
    const wanted = ask.type?.trim().toLowerCase();
    const types = ctx.settings().taskModels;
    const type = types.find(t => t.id === wanted) ?? types.find(t => t.name.trim().toLowerCase() === wanted);
    if (!type) throw badRequest("unknown_task_type", `The editor has no kind of work called "${ask.type ?? ""}". They have: ${types.map(t => t.name).join(", ") || "none"}.`);
    const by = taskModelChoice(type);
    if (!by || sameModel(asker, by)) return { state: "unavailable", reason: `The editor left ${type.name} with the model running this request: do it yourself.` };
    if (!signedIn(ctx, by)) return { state: "unavailable", reason: `${by.model ?? by.agent}, the model the editor chose for ${type.name}, isn't signed in on this computer. Do it yourself, and say so in your closing words.` };
    const brief = ask.brief?.trim();
    if (!brief) throw badRequest("bad_request", "Say what the model should do in `brief`.");
    // A hand-off that failed is asked again; one done or under way serves this call.
    run = mine().find(t => t.context.handOff?.typeId === type.id && t.context.handOff.brief === brief && t.state !== "failed" && t.state !== "cancelled");
    if (!run) {
      run = createTask(ctx, {
        projectId: asker.projectId, kind: "hand_off", agent: by.agent as AgentId, model: by.model, instruction: brief,
        context: { ...sharedContext(asker), threadId: threadOf(asker), checksTaskId: asker.id,
          handOff: { typeId: type.id, name: type.name, ...(type.description && { description: type.description }), brief } },
        createdBy: asker.createdBy, wordsRead: true,
      });
      ctx.log(`[hand-off] ${asker.id}: ${type.name} to ${by.agent}${by.model ? `/${by.model}` : ""} as ${run.id}`);
    }
  }
  const by = named(ctx, { agent: run.agent, ...(run.model && { model: run.model }) });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const now = ctx.repos.tasks.get(run.id);
    if (!now || now.state === "cancelled") return { state: "failed", handoffId: run.id, error: "The hand-off was stopped.", by };
    if (now.state === "failed") return { state: "failed", handoffId: run.id, error: now.error ?? "The model couldn't finish.", by };
    if (now.state === "done") {
      const changeIds = ctx.repos.changes.select("project_id = ? AND json_extract(json, '$.handedOff.taskId') = ?", [now.projectId, now.id], "created_at, rowid").map(c => c.id);
      return { state: "done", handoffId: run.id, summary: now.summary?.trim() || "It finished without saying what it did.", changeIds, by };
    }
    if (FINISHED_TASK.has(now.state) || Date.now() >= deadline) return { state: "working", handoffId: run.id, by };
    await new Promise(done => setTimeout(done, 500));
  }
}

/** The request a hand-off works for, whose edits its saves are. Any other task is its own request. */
export function requestOf(ctx: Ctx, task: Task): Task {
  if (task.kind !== "hand_off" || !task.context.checksTaskId) return task;
  const asker = ctx.repos.tasks.get(task.context.checksTaskId);
  return asker && asker.projectId === task.projectId ? asker : task;
}

/**
 * Run a save as the request's when a hand-off makes it: `run` is given the id of the task that owns what it saves (the
 * request, for a hand-off; the task itself otherwise), and the changes it creates say which model made them.
 */
export function saveAsRequest<T>(ctx: Ctx, taskId: string | undefined, run: (ownerId: string | undefined) => T): T {
  const task = taskId ? ctx.repos.tasks.get(taskId) : undefined;
  if (!task || task.kind !== "hand_off") return run(taskId);
  const asker = requestOf(ctx, task);
  if (asker === task) return run(taskId);
  return handedOffBy.run({ taskId: task.id, requestId: asker.id, name: task.context.handOff?.name ?? "", agent: task.agent, ...(task.model && { model: task.model }) },
    () => run(asker.id));
}
