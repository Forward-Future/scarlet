import { agentCapabilities, canHear, isHandOff, isProjectEditTask, chooseListener, workspaceCapabilities, type AgentId, type Listener, type ListenResult, type Task } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { badRequest } from "../errors.js";
import { FINISHED_TASK, createTask } from "./tasks.js";

/** How long since a host's last heartbeat it still counts as online (`ONLINE_WINDOW_MS` in routes/hosts.ts). */
const HOST_ONLINE_MS = 90_000;

/** The passage a request wants heard, and what it wants to know of it. */
export interface ListenAsk {
  mediaId: string;
  from: number;
  to: number;
  voice?: "me" | "other voices";
  question: string;
}

/**
 * The model that listens for this request, when the request's own model can't hear and a host the editor has online
 * has one signed in that can. None for a request whose model hears itself: it plays the recording with its own tools.
 * Work handed to another model goes by the same rule, on the model it was handed to.
 */
export function listenerFor(ctx: Ctx, task: Task): Listener | undefined {
  if (!isProjectEditTask(task) && !isHandOff(task)) return undefined;
  const env = (ctx.options.env ?? process.env).SCARLET_AGENT_CAPS;
  if (canHear(workspaceCapabilities(agentCapabilities(task.agent, env, task.model)))) return undefined;
  const online = ctx.repos.hosts.select().filter(h => h.lastSeenAt && Date.now() - Date.parse(h.lastSeenAt) < HOST_ONLINE_MS);
  return chooseListener(online.flatMap(h => h.agents), ctx.settings().listening);
}

const sameAsk = (a: ListenAsk, b: ListenAsk) => a.mediaId === b.mediaId && Math.abs(a.from - b.from) < 0.0005 && Math.abs(a.to - b.to) < 0.0005
  && a.voice === b.voice && a.question.trim() === b.question.trim();

/**
 * Have a model that hears listen to a passage for a request whose own model can't, and wait up to `waitMs` for what it
 * heard. The listening is a short run of its own (a listen_check), beside the request and outside the project's queue,
 * that plays the passage and answers the question in words. Asked again for the same passage and question, the request
 * gets the answer already given, or waits on the run already listening.
 */
export async function listenFor(ctx: Ctx, askerId: string, ask: ListenAsk, waitMs: number): Promise<ListenResult> {
  const asker = ctx.repos.tasks.get(askerId);
  if (!asker || (!isProjectEditTask(asker) && !isHandOff(asker))) throw badRequest("invalid_task", "Only a request that edits the video can ask for a passage to be heard.");
  const media = ctx.repos.projects.getMedia(ask.mediaId);
  if (!media || media.projectId !== asker.projectId) throw badRequest("invalid_media", `Media ${ask.mediaId} is not in this project.`);
  if (media.hasAudio === false) throw badRequest("no_audio", `Media ${ask.mediaId} has no sound.`);
  const listener = listenerFor(ctx, asker);
  if (!listener) return { state: "unavailable", reason: ctx.settings().listening === "off" ? "The editor turned listening off."
    : "No model that can hear is signed in on this computer." };
  const earlier = ctx.repos.tasks.select("project_id = ? AND kind = 'listen_check' AND json_extract(json, '$.context.checksTaskId') = ?", [asker.projectId, asker.id], "created_at DESC, rowid DESC")
    .filter(task => task.context.listenCheck && sameAsk(task.context.listenCheck, ask) && task.state !== "cancelled");
  // A listen that failed is asked again; one heard or under way serves this call.
  let check = earlier.find(task => task.state !== "failed");
  if (!check) {
    check = createTask(ctx, {
      projectId: asker.projectId, kind: "listen_check", agent: listener.agent as AgentId, model: listener.model,
      instruction: `Hear ${media.name ?? media.id} from ${ask.from} s to ${ask.to} s`,
      context: { checksTaskId: asker.id, listenCheck: { mediaId: ask.mediaId, from: ask.from, to: ask.to, ...(ask.voice && { voice: ask.voice }), question: ask.question.trim() } },
      createdBy: asker.createdBy,
    });
    ctx.log(`[listen] ${asker.id}: ${listener.agent}${listener.model ? `/${listener.model}` : ""} hears ${ask.mediaId} ${ask.from}–${ask.to} s as ${check.id}`);
  }
  const by: Listener = { agent: check.agent, ...(check.model && { model: check.model }) };
  const deadline = Date.now() + waitMs;
  for (;;) {
    const now = ctx.repos.tasks.get(check.id);
    if (!now || now.state === "cancelled") return { state: "failed", error: "The listening was stopped.", by };
    if (now.state === "failed") return { state: "failed", error: now.error ?? "The model that listens couldn't finish.", by };
    if (now.state === "done") {
      const answer = now.summary?.trim();
      return answer ? { state: "heard", answer, by } : { state: "failed", error: "The model that listens said nothing.", by };
    }
    if (FINISHED_TASK.has(now.state) || Date.now() >= deadline) return { state: "listening", by };
    await new Promise(done => setTimeout(done, 500));
  }
}
