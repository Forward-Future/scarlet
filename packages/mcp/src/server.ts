/**
 * The Scarlet MCP server: the tools an AI editor uses to read a project and
 * propose changes. Everything goes through a `ScarletClient`; the server can
 * be run over stdio (see cli.ts) or embedded in-process.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  agentCapabilities,
  apiPathId,
  isProjectEditTask,
  ScarletApiError,
  taskDialogueOperation,
  toolWait,
  workspaceCapabilities,
  type AgentCapabilities,
  type AgentId,
  type ScarletClient,
  type ScarletToolName,
  type Task,
  type TaskEvent,
} from "@scarlet/shared";
import type { Author } from "@scarlet/timeline";
import { registerChangeAndAssetTools, registerExportAndTaskTools } from "./admin-tools.js";
import { toolAnnotations } from "./annotations.js";
import { ALWAYS_LOAD, listToolsBriefly } from "./brief-tools.js";
import { DialogueEvidence } from "./dialogue-decisions.js";
import { registerDialogueReviewTools } from "./dialogue-review-tools.js";
import { registerDialogueTools, type StagedReviewState } from "./dialogue-tools.js";
import { keptEditsNote } from "./editor-kept.js";
import { registerGraphics } from "./graphics-tools.js";
import { registerInspectionTools } from "./inspection-tools.js";
import { unsharedShape, watchRefusedArguments } from "./mcp-schema.js";
import { registerMediaReadTools } from "./media-read-tools.js";
import { createMediaSession } from "./media-session.js";
import { createRevisionTracker, createSessionErrorHelpers } from "./media-state.js";
import { registerPerception } from "./perception-tools.js";
import { createProposePipeline } from "./propose-pipeline.js";
import { registerTimelineTools } from "./timeline-tools.js";
import {
  describeError,
  errorResult,
  MediaPreparing,
  text,
  toolDiagnostics,
  toolRefusal,
  unmeasured,
  unmeasuredLine,
  type ToolResult,
} from "./tool-result.js";
import { readArtifact, writeArtifact } from "./workspace-files.js";

export { SCARLET_TOOL_NAMES, type ScarletToolName } from "@scarlet/shared";
export { doubledSoundText, validateOps } from "./timeline-validation.js";
export { transcriptionNote } from "./media-state.js";

const SKILL_FROM_CHANGE_TOOLS: ReadonlySet<string> = new Set(["task_log", "task_question", "change_get", "timeline_get", "skill_save_from_change"]);
const IMAGE_TOOLS: ReadonlySet<string> = new Set(["frame_contact_sheet", "frame_contact_sheet_batch", "media_frame", "sound_picture"]);
const SKILL_EDIT_TOOLS: ReadonlySet<string> = new Set(["task_log", "task_question", "skills_list", "skill_save_edit"]);
/** A learning check reads one request for a standing rule. It can read the editor's skills and offer a rule, and nothing else. */
const LEARNING_CHECK_TOOLS: ReadonlySet<string> = new Set(["skills_list", "learning_suggest"]);
/** An area check looks at one frame and says what of it viewers may see, and nothing else. */
const AREA_CHECK_TOOLS: ReadonlySet<string> = new Set(["media_frame", "screen_area"]);
/**
 * A harness with tool search (Claude Code's `ToolSearch`) lists tools by name and loads a definition when the model
 * looks it up; these are sent whole from the start of a request, as small tools nearly every request reads. A side
 * check or a skill revision has only a few tools, so all of them are, and no turn goes on a search. Claude Code cuts an
 * upfront description at 4,096 characters, so each of these stays under that (`tools.test.ts`). A harness that lists
 * tools briefly (Gemini's) gets the same tools whole, and the rest through `tool_call` (`brief-tools.ts`).
 */
export const ALWAYS_LOADED_TOOLS: ReadonlySet<string> = new Set(["project_get", "timeline_get", "task_log", "task_question"]);
const FEW_TOOL_TASKS: ReadonlySet<string> = new Set(["area_check", "learning_check", "skill_edit", "skill_from_change"]);
const PASS_WIDE_TOOLS: ReadonlySet<string> = new Set(["timeline_propose", "timeline_first_cut", "timeline_crossfade_audio", "timeline_transition", "timeline_framing", "timeline_picture_sync", "captions_generate", "dialogue_apply_cuts", "dialogue_review_save"]);

/** When the tool call under way has to have answered by, in ms since the epoch: its harness's tool wait from when it began. */
const callDeadline = new AsyncLocalStorage<number>();

export interface ScarletMcpContext {
  projectId: string;
  /** How long a cut or an edge check waits for word alignment to reach it. Tests shorten it. */
  alignmentWaitMs?: number;
  /** Time budget for each collection of slow join measurements. */
  joinWaitMs?: number;
  /** Agent task this session is running for; enables task_log/task_question and tags changes. */
  taskId?: string;
  /** Claim that launched this MCP session, including when a provider reconnects. */
  taskStartedAt?: string;
  /** Authoritative task fetched at startup, for task-specific tools. */
  task?: Task;
  author: Author;
  /** Which CLI is driving this session; sets the default capabilities. */
  agent?: AgentId | string;
  /** What the harness delivers to the model. Defaults to agentCapabilities(agent). Without audio, no tool offers WAV. */
  capabilities?: AgentCapabilities;
  /** Directory where the server may write files (OTIO exports). Defaults to the OS temp dir. */
  workDir?: string;
  /** fetch used for binary endpoints (frames). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export function createScarletMcpServer(workspace: ScarletClient, ctx: ScarletMcpContext): McpServer {
  const startedAt = ctx.taskStartedAt ?? ctx.task?.startedAt;
  const client = workspace.forProject(ctx.projectId, ctx.taskId ? { taskId: ctx.taskId, startedAt } : undefined);
  if (ctx.taskId) apiPathId(ctx.taskId);
  if (ctx.task && ctx.task.projectId !== ctx.projectId) throw new Error("Task belongs to a different project");
  const evidence = new DialogueEvidence();
  // A request is launched with its harness's own shell, file and web tools; a run that edits no video (a side check, a
  // skill's revision) with Scarlet's alone, and a client Scarlet didn't launch as it says of itself.
  const harness = ctx.capabilities ?? agentCapabilities(ctx.agent);
  const caps = ctx.task && isProjectEditTask(ctx.task) ? workspaceCapabilities(harness) : harness;

  type DialogueOperation = ReturnType<typeof taskDialogueOperation>;
  let legacyOperation: Promise<DialogueOperation> | undefined;
  const dialogueOperation = () => {
    if (!ctx.task || ctx.task.context.dialogueOperation !== undefined) return ctx.task?.context.dialogueOperation ?? "none";
    // Older engines did not persist the chosen operation. Fold their editor answers using the same command grammar.
    return legacyOperation ??= (async () => {
      const events = ctx.taskId ? (await client.task(ctx.taskId, "conversation")).events : [];
      const answers = events.filter(event => event.type === "answer").map(event => event.text);
      if (taskDialogueOperation(ctx.task!, answers) === "none") return "none";
      const { skills } = await client.skills();
      return taskDialogueOperation(ctx.task!, answers, skills);
    })().catch(error => { legacyOperation = undefined; throw error; });
  };
  const localPausesMode = async () => await dialogueOperation() === "local-pauses";

  const revision = createRevisionTracker(client, ctx.task);
  const scanScopes = new Map<string, number>();
  const stagedState: StagedReviewState = { stagedReview: undefined, stageWithoutAppliedCuts: undefined };
  const authoring = ctx.task?.kind === "skill_from_change" ? ctx.task.context : undefined;
  const server = new McpServer(
    { name: "scarlet", version: "0.1.4" },
    {
      instructions: authoring
        ? "Scarlet exposes the approved change and timeline version, communication with the editor, and saving the requested skill."
        : ctx.task?.kind === "skill_edit"
        ? "Scarlet exposes the tools for revising one of the editor’s skills; an empty MCP resource list is normal."
        : ctx.task?.kind === "learning_check"
        ? "Scarlet exposes the tools for reading the editor’s skills and offering a rule for one; an empty MCP resource list is normal."
        : ctx.task?.kind === "area_check"
        ? "Scarlet exposes the tools for looking at one frame of a recording and saving what of it viewers may see; an empty MCP resource list is normal."
        : "Scarlet exposes project context and editing operations as tools; an empty MCP resource list is normal. project_get returns the current edit and the editor’s selection. Transcript and waveform tools prepare missing data on demand.",
    },
  );
  let diagnosticSessionClosed = false;
  const fetchImpl = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  let tempDir: Promise<string> | undefined;
  const artifactDir = () => ctx.workDir ?? (tempDir ??= mkdtemp(join(tmpdir(), "scarlet-mcp-")));

  const errors = createSessionErrorHelpers();

  /**
   * Seconds a wait inside the tool call under way may take: what is left of the call's time, less `margin` for the work
   * after it, and no more than `most`. A save's waits run one after another: budgeted each as if it had the whole call,
   * together they could run to twice its harness's deadline. Outside a call, as if one began now.
   */
  function waitLeft(margin: number, most = Infinity) {
    const deadline = callDeadline.getStore() ?? Date.now() + toolWait(caps, 0) * 1000;
    return Math.max(0, Math.floor(Math.min(most, (deadline - Date.now()) / 1000 - margin)));
  }

  /** Posts an event to this session's task. `error` is why one didn't arrive; a session without a task has nowhere to post. */
  async function postEvent(ev: Omit<TaskEvent, "taskId">): Promise<{ posted: boolean; error?: string }> {
    if (!ctx.taskId) return { posted: false };
    try {
      await client.postTaskEvent(ctx.taskId, { ...ev, taskId: ctx.taskId });
      return { posted: true };
    } catch (err) {
      const error = describeError(err);
      console.error(`[scarlet-mcp] failed to post task event: ${error}`);
      return { posted: false, error };
    }
  }

  const session = createMediaSession({
    client,
    projectId: ctx.projectId,
    taskId: ctx.taskId,
    taskStartedAt: ctx.taskStartedAt,
    task: ctx.task,
    alignmentWaitMs: ctx.alignmentWaitMs,
    evidence,
    errors,
    postEvent,
  });

  type ToolOutcome = "ok" | "failed" | "refused" | "preparing" | "degraded";
  function logToolResult(toolName: string, outcome: ToolOutcome, elapsedMs: number, evidenceMisses: number, result?: ToolResult) {
    if (!ctx.taskId || !startedAt || diagnosticSessionClosed) return;
    const path = `/projects/${apiPathId(ctx.projectId)}/tasks/${apiPathId(ctx.taskId)}/tool-diagnostic`;
    const signal = AbortSignal.timeout(2000);
    // How much went back to the model, as sizes: what fills a run's context is the results it reads.
    const resultChars = result?.content.reduce((sum, item) => sum + (item.type === "text" ? item.text.length : 0), 0);
    const resultMedia = result?.content.filter(item => item.type !== "text").length;
    void client.request("POST", path, { tool: toolName, outcome, elapsedMs, evidenceMisses, ...(result && { resultChars }), ...(resultMedia && { resultMedia }) }, { signal })
      .catch((err: unknown) => {
        // Let outstanding reports finish when the tool session closes, but quiet failures during teardown.
        if (!diagnosticSessionClosed && !(err instanceof ScarletApiError && err.status === 404))
          console.error(`[scarlet-mcp] task ${ctx.taskId}: could not report ${toolName} outcome=${outcome} elapsedMs=${elapsedMs} evidenceMisses=${evidenceMisses}`);
      });
  }

  // The editor's Keeps of edits this request flagged, which the run hears of on its next tool call, a few seconds apart at most.
  const heardKept = new Set<string>();
  const keptThread = ctx.task && ["edit", "note", "revise"].includes(ctx.task.kind) ? ctx.task.context.threadId ?? ctx.task.id : undefined;
  let keptAskedAt = 0;
  async function keptLine() {
    if (!keptThread || Date.now() - keptAskedAt < 5000) return undefined;
    keptAskedAt = Date.now();
    try {
      return keptEditsNote((await client.keptEdits(ctx.projectId, keptThread)).kept, heardKept);
    } catch {
      return undefined;
    }
  }

  /** A call's outcome in the run's diagnostics, and what it refused in the task's history. */
  async function reportResult(name: string, outcome: ToolOutcome, began: number, misses: number, result: ToolResult) {
    // Preserve the project's existing refusal receipt separately from the operational log.
    const refusal = toolRefusal(result);
    if (refusal && !result.isError) outcome = "refused";
    logToolResult(name, outcome, Math.round(performance.now() - began), misses, result);
    if (refusal) await postEvent({ type: "log", text: refusal.text, data: { kind: "tool_refused", tool: `scarlet.${name}`, ...refusal.data } });
  }

  // The calls of each tool under way. A harness can send several calls at once, as a save and the next read.
  const running = new Map<ScarletToolName, Set<Promise<unknown>>>();
  /** Each tool's parameters, as the SDK checks a call's arguments against them. */
  const toolParameters = new Map<string, z.ZodTypeAny>();
  function tool<Shape extends z.ZodRawShape>(
    name: ScarletToolName,
    description: string,
    shape: Shape,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
  ) {
    if (name === "source_audio" && !caps.audio) return;
    // Only a harness with file tools can put anything in the artifact directory for asset_add to import.
    if (name === "asset_add" && !caps.files) return;
    if (authoring && !SKILL_FROM_CHANGE_TOOLS.has(name)) return;
    if (!caps.images && IMAGE_TOOLS.has(name)) return;
    // A request to revise a skill edits no video. It gets the tools for talking to the editor and for the skill.
    if (ctx.task?.kind === "skill_edit" && !SKILL_EDIT_TOOLS.has(name)) return;
    // A rule approved in Learnings is saved with no one to answer a question: what the save can't settle goes back to
    // the editor beside the rule, in its closing words.
    if (name === "task_question" && ctx.task?.kind === "skill_edit" && ctx.task.context.learningId) return;
    // Every request is read for a standing rule by a learning check, which has that tool and the skills. The run that
    // edits doesn't offer rules as well, so the editor never gets the same rule twice in two wordings.
    if (ctx.task?.kind === "learning_check" ? !LEARNING_CHECK_TOOLS.has(name) : name === "learning_suggest") return;
    if (ctx.task?.kind === "area_check" && !AREA_CHECK_TOOLS.has(name)) return;
    const inputSchema = unsharedShape(shape);
    toolParameters.set(name, z.object(inputSchema));
    const alwaysLoad = ALWAYS_LOADED_TOOLS.has(name) || FEW_TOOL_TASKS.has(ctx.task?.kind ?? "");
    server.registerTool(name, { description, inputSchema, annotations: toolAnnotations(name), ...(alwaysLoad && { _meta: { [ALWAYS_LOAD]: true } }) }, (async (args: z.infer<z.ZodObject<Shape>>) => {
      const calls = running.get(name) ?? new Set<Promise<unknown>>();
      running.set(name, calls);
      let finish!: () => void;
      const call = new Promise<void>(resolve => { finish = resolve; });
      calls.add(call);
      const began = performance.now();
      const deadline = Date.now() + toolWait(caps, 0) * 1000;
      try {
        const missed = new Map<string, string>();
        const diagnostic = { misses: new Set<string>(), preparing: false };
        let outcome: ToolOutcome;
        let result: ToolResult;
        try {
          if (["timeline_propose", "timeline_first_cut", "timeline_crossfade_audio", "timeline_framing", "timeline_picture_sync", "captions_generate", "asset_add", "dialogue_check_repeats"].includes(name) && await localPausesMode())
            throw new Error("This request only tightens local pauses. Save classified pauses with dialogue_apply_cuts.");
          if (PASS_WIDE_TOOLS.has(name)) {
            const selected = await revision.useStagedCut();
            if (selected) throw selected;
          }
          result = await callDeadline.run(deadline, () => toolDiagnostics.run(diagnostic, () => unmeasured.run(missed, () => handler(args))));
          outcome = result.isError ? "failed" : diagnostic.preparing ? "preparing" : "ok";
        } catch (err) {
          outcome = err instanceof MediaPreparing ? "preparing" : "failed";
          result = err instanceof MediaPreparing ? text(err.message) : errorResult(err);
        }
        // Count omissions without logging the measurement or the words returned to the model.
        const misses = new Set([...missed.keys(), ...diagnostic.misses]).size;
        if (outcome === "ok" && misses) outcome = "degraded";
        const line = unmeasuredLine(missed);
        if (line) result = { ...result, content: [...result.content, { type: "text", text: line }] };
        const kept = await keptLine();
        if (kept) result = { ...result, content: [...result.content, { type: "text", text: kept }] };
        await reportResult(name, outcome, began, misses, result);
        return result;
      } finally {
        calls.delete(call);
        finish();
      }
    }) as never);
  }

  /** The calls of these tools under way now, finished. */
  async function finished(names: readonly ScarletToolName[]) {
    await Promise.all(names.flatMap(name => [...(running.get(name) ?? [])]));
  }

  async function readApprovedExample(changeId: string) {
    if (!authoring?.version || changeId !== authoring.changeId) throw new Error("This skill reads only the change the editor selected.");
    const { change } = await client.changeRecord(changeId);
    if (change.projectId !== ctx.projectId || change.state !== "approved" || (change.appliedVersion ?? change.toVersion) !== authoring.version) {
      throw new Error("The original change is no longer approved at the requested version.");
    }
    return change;
  }

  // Register tools in exact canonical order.
  const inspection = registerInspectionTools({
    tool, client, projectId: ctx.projectId, taskId: ctx.taskId, task: ctx.task, caps,
    fetchImpl, session, errors, scanScopes, waitLeft, readPassage: revision.readPassage, postEvent,
  });

  const proposePipeline = createProposePipeline({
    client, projectId: ctx.projectId, taskId: ctx.taskId, task: ctx.task, author: ctx.author,
    caps, session, errors, waitLeft, postEvent, sourceFrame: inspection.sourceFrame,
    getPerception: () => perception,
  });

  registerMediaReadTools({
    tool, client, projectId: ctx.projectId, caps, task: ctx.task, session, errors,
  });

  registerDialogueTools({
    tool, client, projectId: ctx.projectId, taskId: ctx.taskId, taskStartedAt: ctx.taskStartedAt,
    task: ctx.task, author: ctx.author, caps, joinWaitMs: ctx.joinWaitMs, evidence, session,
    errors, proposePipeline, scanScopes, stagedState, dialogueOperation, waitLeft, finished,
    readPassage: revision.readPassage, postEvent, prepareReview: id => reviewTools.prepareReview(id),
    getPerception: () => perception,
  });

  const reviewTools = registerDialogueReviewTools({
    tool, client, projectId: ctx.projectId, taskId: ctx.taskId, task: ctx.task, author: ctx.author,
    caps, session, errors, revision, stagedState, localPausesMode,
    rendersDone: inspection.rendersDone, inspect: inspection.inspect, postEvent,
    getPerception: () => perception,
  });

  // The only close handler: a second assignment would replace this one.
  server.server.onclose = () => { diagnosticSessionClosed = true; inspection.close(); reviewTools.close(); };

  const perception = registerPerception({
    tool, client, projectId: ctx.projectId,
    otherInputWords: async (mediaId, words) => (await session.otherInput(mediaId, words)).other,
    seesFrames: caps.images,
    peekTimeline: session.peekTimeline,
    getProject: session.getProject,
    readPassage: revision.readPassage,
    transcriptWords: session.transcriptWords,
    showWords: session.showWords,
    settledThrough: session.settledThrough,
    readLevels: session.readLevels,
    unavailable: errors.unavailableOnce,
    readWaveform: (mediaId, from, to, points) => session.readPrepared(mediaId, "waveform", () => client.waveform(mediaId, from, to, points, true)),
  });

  registerTimelineTools({
    tool, client, projectId: ctx.projectId, taskId: ctx.taskId, task: ctx.task, authoring,
    caps, session, errors, proposePipeline, useStagedCut: revision.useStagedCut, readApprovedExample,
  });

  registerChangeAndAssetTools({
    tool, client, projectId: ctx.projectId, task: ctx.task, author: ctx.author, caps, authoring,
    artifactDir, localPausesMode, readApprovedExample,
  });

  registerGraphics({
    tool, client, projectId: ctx.projectId, task: ctx.task, author: ctx.author, caps,
    readArtifact: async path => readArtifact(await artifactDir(), path),
    writeArtifact: async (path, data) => writeArtifact(await artifactDir(), path, data),
  });

  registerExportAndTaskTools({
    tool, client, projectId: ctx.projectId, taskId: ctx.taskId, startedAt, task: ctx.task,
    agent: ctx.agent, getHeader: session.getHeader, artifactDir, postEvent,
  });

  watchRefusedArguments(server, async (name, args, began, result) => {
    const parameters = toolParameters.get(name);
    if (parameters && !(await parameters.safeParseAsync(args ?? {})).success) await reportResult(name, "failed", began, 0, result);
  });
  if (caps.briefTools) listToolsBriefly(server);
  return server;
}
