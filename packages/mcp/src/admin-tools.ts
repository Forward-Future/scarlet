import { basename, join } from "node:path";
import { z } from "zod/v3";
import {
  apiPathId,
  isProjectEditTask,
  QuestionChoices,
  skillEditTarget,
  skillTaskTarget,
  SuggestLearningRequest,
  TaskSkillDraft,
  type AgentCapabilities,
  type AgentId,
  type ProjectDetail,
  type ScarletClient,
  type Skill,
  type Task,
  type TaskEvent,
} from "@scarlet/shared";
import { clipById, describeDiff, type Author, type Change } from "@scarlet/timeline";
import { errorText, json, text, type ToolRegistrar } from "./tool-result.js";
import { guessKind, readArtifact, sanitize, writeArtifact } from "./workspace-files.js";

export interface ChangeAndAssetToolsDeps {
  tool: ToolRegistrar;
  client: ScarletClient;
  projectId: string;
  task?: Task;
  author: Author;
  caps: Pick<AgentCapabilities, "shell">;
  authoring: Task["context"] | undefined;
  artifactDir(): Promise<string> | string;
  localPausesMode(): Promise<boolean>;
  readApprovedExample(changeId: string): Promise<Change>;
}

/** Registers changes, notes, renders, and asset_add (immediately preceding registerGraphics). */
export function registerChangeAndAssetTools(deps: ChangeAndAssetToolsDeps) {
  const { tool, client, projectId, task, author, caps, authoring, artifactDir, localPausesMode, readApprovedExample } = deps;

  // -- changes & notes ------------------------------------------------------

  tool(
    "change_get",
    authoring ? "Read the approved change and the diff of the edits the editor kept." : "Get a change by id: description, state (proposed|rendering|ready|approved|rejected|revising|failed), author, from/to versions, affected ranges, review notes on its cuts, and the diff in plain lines. Use when revising a change the editor sent back; timeline_join_audit measures its joins.",
    { changeId: z.string() },
    async ({ changeId }) => {
      if (authoring) {
        const change = await readApprovedExample(changeId);
        const approved = change.appliedVersion ?? change.toVersion;
        const before = change.appliedReview?.originalVersion ?? (change.appliedOnto === approved ? change.fromVersion : change.appliedOnto ?? change.fromVersion);
        // A partial acceptance can leave the proposal's title and its diff describing edits the editor skipped.
        const partial = change.approvedSpots !== undefined || !!change.restoredCuts?.length;
        const { description: diff } = await client.diff(projectId, before, approved, "id");
        return json({ change: { id: change.id, description: partial ? undefined : change.description, state: change.state,
          appliedVersion: approved, approvedSpots: change.approvedSpots }, diff });
      }
      const { change, diff } = await client.change(changeId);
      return json({ change, diff: describeDiff(diff, undefined, clipById) });
    },
  );

  tool(
    "change_list",
    "List changes of the project, optionally filtered by state (proposed, rendering, ready, approved, rejected, revising, failed).",
    { state: z.string().optional() },
    async ({ state }) => {
      const { changes } = await client.changes(projectId, state);
      const lines = changes.map((c: Change) => `${c.id} [${c.state}${c.intent ? ` ${c.intent}` : ""}] ${c.fromVersion}→${c.toVersion} ${c.author.name}: ${c.description}`);
      return text(`${changes.length} change(s)${state ? ` in state ${state}` : ""}:\n${lines.join("\n")}`);
    },
  );

  tool(
    "notes_list",
    "List review notes (editor feedback pinned to a timeline time and clip ids). Filter by state: open, in_progress, resolved, dismissed. Each note has time/end (timeline seconds), clipIds, text, author, assignedTo and optionally the changeId it is about.",
    { state: z.string().optional().describe("Default: all states") },
    async ({ state }) => {
      const { notes } = await client.notes(projectId, state);
      const lines = notes.map(
        (n) => `${n.id} [${n.state}] @${n.time.toFixed(2)}${n.end !== undefined ? `–${n.end.toFixed(2)}` : ""} s on ${n.version}${n.clipIds.length ? ` clips ${n.clipIds.join(",")}` : ""}${n.changeId ? ` about ${n.changeId}` : ""}${n.assignedTo ? ` for ${n.assignedTo}` : ""} by ${n.author.name}: ${n.text}${(n.replies ?? []).map(r => ` | reply from ${r.author.name}: ${r.text}`).join("")}`,
      );
      return text(`${notes.length} note(s):\n${lines.join("\n")}`);
    },
  );

  tool(
    "note_reply",
    "Reply to a review note (the editor sees your reply in the thread). Use it to explain what you did or why you did something different; use timeline_propose with noteIds to actually address the note.",
    { noteId: z.string(), text: z.string().min(1) },
    async ({ noteId, text: body }) => {
      if (await localPausesMode() && !task?.context.noteIds?.includes(noteId)) throw new Error("Choose a note attached to this request.");
      const { note } = await client.replyNote(noteId, body, author);
      return text(`Replied to note ${noteId}; it is ${note.state}.`);
    },
  );

  tool(
    "note_resolve",
    "Mark a review note resolved after you have addressed it (usually after proposing a change with that noteId).",
    { noteId: z.string() },
    async ({ noteId }) => {
      if (await localPausesMode() && !task?.context.noteIds?.includes(noteId)) throw new Error("Choose a note attached to this request.");
      const { note } = await client.updateNote(noteId, { state: "resolved" });
      return text(`Note ${noteId} is ${note.state}.`);
    },
  );

  // -- renders --------------------------------------------------------------

  tool(
    "render_request",
    "Request a short quality check with a timeline range in seconds. Use preview for low resolution or full for delivery quality. Omit the range with full only for an explicitly requested whole-video render. Proposing and approving edits do not require a render. Poll render_status with the returned id.",
    {
      kind: z.enum(["preview", "full"]).default("preview"),
      version: z.string().optional().describe("Default head"),
      range: z.object({ start: z.number().min(0), end: z.number().min(0) }).optional(),
    },
    async ({ kind, version, range }) => {
      if (kind === "preview" && !range) return errorText("Choose a short timeline range for the preview, in seconds.");
      const { render } = await client.requestRender(projectId, {
        kind: range ? "segment" : kind,
        version,
        range,
        quality: kind === "full" ? "delivery" : "preview",
      });
      return json(render);
    },
  );

  tool(
    "render_status",
    "Status of a render: state (queued|running|done|failed|cancelled), progress 0..1, duration, dimensions, error.",
    { renderId: z.string(), inspectFile: z.boolean().optional().describe("Probe the completed file for its actual duration, dimensions, fps, bitrate and audio/video stream details, and measure its sound's loudness (integrated LUFS, loudness range LU, true peak dBTP) with every gain and effect applied, to compare with media_profile's figures for the source") },
    async ({ renderId, inspectFile }) => {
      const { render, fileInfo } = await client.render(renderId, inspectFile);
      return json(fileInfo ? { ...render, fileInfo } : render);
    },
  );

  // -- assets ---------------------------------------------------------------

  tool(
    "asset_add",
    `Upload an existing file from this task’s artifact directory (for example an animation, graphic or music bed) into the project's media so it can be placed on the timeline with addClip. \`kind\` is video|audio|image|graphic (guessed from the extension when omitted). \`provenance\` records how it was made (prompt/tool) so others can revise it.${caps.shell ? " For B-roll taken from the web (an article, a post, a clip), \`source\` records the page's address, when it was captured, the page as captured (a PNG, JPEG or WebP in the artifact directory) and the part of that capture in the video (fractions of its width and height), or for a clip of a video its seconds of that video; the editor sees it on the card of the edit that lays the file over the picture." : ""} Returns the new mediaId and probed duration. Agents never upload finished videos; Scarlet renders the edit.`,
    {
      path: z.string().describe("File inside the task artifact directory (relative or absolute path)"),
      kind: z.enum(["video", "audio", "image", "graphic"]).optional(),
      provenance: z.object({ prompt: z.string().optional(), model: z.string().optional(), name: z.string().optional() }).optional(),
      // Only a run that can reach the web has anything to say of where a file came from.
      ...(caps.shell ? { source: z.object({
        url: z.string().describe("The page's web address"),
        capturedAt: z.string().optional().describe("When it was captured, ISO 8601; default now"),
        capture: z.string().optional().describe("The page as captured, a picture in the task artifact directory"),
        region: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }).optional()
          .describe("The part of the capture in the video, as fractions of its width and height"),
        clip: z.object({ start: z.number().min(0), end: z.number().min(0) }).optional().describe("For a clip of a video on the web: the part of that video it is, in its seconds"),
      }).optional() } : {}),
    },
    async ({ path, kind, provenance, ...rest }) => {
      const source = (rest as { source?: { url: string; capturedAt?: string; capture?: string; region?: { left: number; top: number; right: number; bottom: number }; clip?: { start: number; end: number } } }).source;
      const data = await readArtifact(await artifactDir(), path);
      const name = basename(path);
      const guessed = kind ?? guessKind(name);
      const fd = new FormData();
      fd.append("file", new Blob([data]), name);
      fd.append("kind", guessed);
      fd.append(
        "provenance",
        JSON.stringify({ by: "agent", name: provenance?.name ?? author.name, model: provenance?.model ?? author.model, prompt: provenance?.prompt, createdAt: new Date().toISOString() }),
      );
      if (source) {
        const { capture, ...rest } = source;
        fd.append("source", JSON.stringify({ ...rest, capturedAt: rest.capturedAt ?? new Date().toISOString() }));
        if (capture) fd.append("capture", new Blob([await readArtifact(await artifactDir(), capture)]), basename(capture));
      }
      const { media } = await client.post<{ media: ProjectDetail["project"]["media"][number] }>(`/projects/${projectId}/media`, fd);
      return json(media);
    },
  );
}

export interface ExportAndTaskToolsDeps {
  tool: ToolRegistrar;
  client: ScarletClient;
  projectId: string;
  taskId?: string;
  startedAt?: string;
  task?: Task;
  agent?: AgentId | string;
  getHeader(): Promise<{ project: { head?: string | null } }>;
  artifactDir(): Promise<string> | string;
  postEvent(ev: Omit<TaskEvent, "taskId">): Promise<{ posted: boolean; error?: string }>;
  /** Told each file `export_otio` wrote, which the editor is given by its path. */
  exported?(path: string): void;
  /** The kinds of work the editor gave other models, signed in now (Task models). A request with any has `hand_off`. */
  taskModels?: TaskModelOffer[];
  /** Seconds a wait inside the call under way may take (`waitLeft` in server.ts). */
  waitLeft(margin: number, most?: number): number;
}

/** A kind of work the editor gave another model, as the engine tells a request of it. */
export interface TaskModelOffer { id: string; name: string; description?: string; by: { agent: string; model?: string; label?: string } }

/** Registers export_otio, task events, and skills/learnings (immediately after registerGraphics). */
export function registerExportAndTaskTools(deps: ExportAndTaskToolsDeps) {
  const { tool, client, projectId, taskId, startedAt, task, agent, getHeader, artifactDir, exported, postEvent, taskModels, waitLeft } = deps;

  tool(
    "export_otio",
    "Export a version (default head) as an OpenTimelineIO (.otio) file that DaVinci Resolve imports natively (File > Import > Timeline). Saves to the working directory and returns the path.",
    { version: z.string().optional(), path: z.string().optional().describe("Destination file path; default <workDir>/exports/<version>.otio") },
    async ({ version, path }) => {
      let v = version;
      if (!v || v === "head") {
        const detail = await getHeader();
        if (!detail.project.head) throw new Error("project has no head version to export");
        v = detail.project.head;
      }
      const otio = await client.get<unknown>(`/projects/${projectId}/versions/${apiPathId(v)}/export.otio`);
      const dest = await writeArtifact(await artifactDir(), path ?? join("exports", `${sanitize(v)}.otio`), JSON.stringify(otio, null, 2));
      exported?.(dest);
      return json({ path: dest, version: v });
    },
  );

  // -- task events ----------------------------------------------------------

  tool(
    "task_log",
    "Report progress to the editor. Optional edit references link exact phrases in the text to saved changes.",
    { text: z.string().min(1), excerpt: z.string().trim().min(1).max(280).optional()
        .describe("A short verbatim transcript quote for a linked dialogue edit, when it helps identify the passage"),
      activity: z.string().trim().max(48).regex(/^[\p{L}][\p{L}’-]*(?: [\p{L}][\p{L}’-]*)?$/u, "Give the activity in one or two words of letters only, such as Checking captions. Put the rest in text.")
        .optional().describe("Current one- or two-word action, e.g. Checking captions"), edits: z.array(z.object({
      phrase: z.string().min(1).describe("Exact consecutive words in text, in reading order"),
      changeId: z.string().min(1), spot: z.number().int().nonnegative().default(0).describe("Zero-based index in timelineEdits, or affectedRanges when the proposal has no named edits"),
    })).max(32).optional() },
    async ({ text: body, activity, excerpt, edits }) => {
      const { posted, error } = await postEvent({ type: "log", text: body, data: { kind: "editor_progress", ...(activity ? { activity } : {}), ...(edits?.length ? { edits, ...(excerpt ? { excerpt } : {}) } : {}) } });
      if (posted) return text("Logged.");
      // A task whose update was lost or refused is still a Scarlet task. It hears what failed, and the request goes on without the update.
      return text(error === undefined ? "Not running as a Scarlet task; message not posted."
        : `This update didn't reach the editor: ${error}. Carry on with the request unless the task itself has ended.`);
    },
  );

  tool(
    "task_question",
    "Ask the editor a question when you cannot proceed without their decision (which take, what aspect ratio, whether to cut a section). Posting the question pauses the task; STOP working immediately after calling this and end your turn. Scarlet resumes the task with the editor's answer as your next message. Ask only when needed, and make the question specific with the options you see. When the question has two to four clear answers, also give them as choices: the editor answers with one press, or writes their own.",
    { text: z.string().min(1),
      choices: QuestionChoices.optional().describe("Two to four short answers the editor can pick with one press, each a few words in their language (\"Keep the cold open\", \"Cut it\"). Leave out when the answer is open-ended.") },
    async ({ text: body, choices }) => {
      if (!taskId) {
        return text("Not running as a Scarlet task, so nobody can answer. Make the most reasonable assumption, state it in your summary, and continue.");
      }
      const { waiting } = await client.postTaskQuestion(taskId, startedAt, body, undefined, undefined, choices);
      return text(
        waiting
          ? "Question posted to the editor. Stop now: do not call any more tools and end your turn with a one-line summary of what you have done so far. Scarlet resumes the task with the editor's answer."
          : "This task attempt has already ended. Stop now.",
      );
    },
  );

  // -- task models ------------------------------------------------------------

  // The kinds of work the editor gave other models in Settings (Task models). A request hands each such piece to its model.
  const offers = taskModels ?? [];
  if (offers.length && task && taskId && isProjectEditTask(task)) {
    const nameOf = (by: { agent: string; model?: string; label?: string }) => by.label ?? (by.agent === "gemini" && !by.model ? "Gemini" : by.model ?? by.agent);
    const told = new Set<string>();
    tool(
      "hand_off",
      "Hand a piece of this request to the model the editor chose for that kind of work. The editor gave these kinds of work to other models in Settings, each with what counts as it:\n" +
        offers.map(o => `- ${o.name} (${nameOf(o.by)})${o.description ? `: ${o.description}` : ""}`).join("\n") +
        "\nWhen part of the request is one of these, don't do that part yourself: hand it off, by the kind's name, with a brief that says exactly what to make or change, where on the timeline (in seconds), and what it needs from the editor's words or from your own work so far. That model works on this project with Scarlet's tools and saves its edits into this request, and you hear back what it saved and said. It can't ask the editor anything. A hand-off takes minutes, and several can run at once: while one is still working, call again with its handoffId. Its edits change the timeline, so read it again before your next save. Do the rest of the request yourself, and say in your closing words what each model did.",
      { type: z.string().trim().min(1).max(40).optional().describe("The kind of work, by its name above"),
        brief: z.string().trim().min(1).max(8000).optional().describe("What the model should make or change, where, and what it needs to know"),
        handoffId: z.string().min(1).optional().describe("A hand-off already under way, to wait for it") },
      async ({ type, brief, handoffId }) => {
        if (!handoffId && (!type || !brief)) return text("Give the kind of work and a brief, or the handoffId of a hand-off under way.");
        const result = await client.handOff(projectId, { taskId, ...(type && { type }), ...(brief && { brief }), ...(handoffId && { handoffId }) }, waitLeft(10, 240));
        if (result.state === "unavailable") return text(result.reason);
        const by = nameOf(result.by);
        const kind = offers.find(o => o.id === type || o.name.toLowerCase() === type?.toLowerCase())?.name ?? type ?? "the work";
        // The chat says once that the work went to another model: as it is handed over. A call that only asks after a
        // hand-off by its id says nothing, since a run resumed in a new session would say it a second time.
        if (!handoffId && !told.has(result.handoffId) && result.state !== "failed") {
          told.add(result.handoffId);
          await postEvent({ type: "log", text: `Handed ${kind.toLowerCase()} to ${by}.`, data: { kind: "editor_progress", activity: "Handing off" } });
        }
        if (result.state === "done") return json({ handoffId: result.handoffId, by, saved: result.changeIds, said: result.summary,
          next: result.changeIds.length ? "Read the timeline again before your next save: these edits changed it." : undefined });
        if (result.state === "working") return text(`${by} is still working on it (handoffId ${result.handoffId}). Carry on with the rest of the request, then call hand_off again with this handoffId for what it saved.`);
        return text(`${by} couldn't finish it (handoffId ${result.handoffId}): ${result.error} Do that part yourself.`);
      },
    );
  }

  // -- skills ---------------------------------------------------------------

  tool(
    "skills_list",
    "List the workflows available for this editing request, or read one by passing its id or exact name as skillId (for example, dialogue-pass). Reading a workflow changes no tool behavior.",
    { skillId: z.string().min(1).optional() },
    async ({ skillId }) => {
      const { skills } = await client.skills({ projectId, view: "assistant",
        ...(taskId && { taskId }) });
      const applicable = skills.filter((s: Skill) => s.enabled);
      if (skillId) {
        const skill = applicable.find(s => s.id === skillId) ?? applicable.find(s => s.name === skillId);
        if (!skill) throw new Error("This skill is unavailable for this request. Use skills_list to find an available workflow.");
        return text(skill.content);
      }
      return text(applicable.length ? applicable.map((s) => `${s.id} ${s.name} (${s.scope}): ${s.description}`).join("\n") : "No skills enabled.");
    },
  );

  tool(
    "learning_suggest",
    "Offer the editor a standing rule for one of their skills. It goes on a list they review when they choose, with what they said; nothing in the skill changes unless they approve it. Give the rule as one plain sentence that would read well in the skill, and the skill it belongs in, by id or exact name. In replaces, quote each passage of that skill the rule contradicts or overrides, word for word and one stretch of text each; the editor sees them beside the rule before deciding, and approving it replaces them. Leave replaces out when nothing in the skill says otherwise. When the rule comes from what the editor decided, give from: the ids of the decisions it comes from, as your prompt lists them, and what they were in a few words as they read after their count (\"cuts you rejected\", \"laughs you kept\"); the editor sees those decisions in place of words they said.",
    SuggestLearningRequest.shape,
    async ({ rule, skill, replaces, from }) => {
      if (!taskId) return text("Not running as a Scarlet task, so there is no list to add this to.");
      const { learning, skill: saved } = await client.suggestLearning(projectId, taskId, { rule, skill, ...(replaces?.length && { replaces }), ...(from && { from }) });
      return json({ learningId: learning.id, skill: saved.name, state: learning.state, ...(learning.replaces && { replaces: learning.replaces.length }),
        ...(learning.learnedFrom && { from: learning.learnedFrom.decisions.length }) });
    },
  );

  const target = task && task.id === taskId && (!agent || task.agent === agent) ? skillTaskTarget(task, projectId) : undefined;
  if (task && target) {
    tool(
      "skill_save_from_change",
      `Save the team skill "${target.name}" requested by the editor for approved change ${target.changeId}. Provide a one-line description and the reusable Markdown instructions without frontmatter.`,
      TaskSkillDraft.shape,
      async ({ description, instructions }) => {
        const { skill } = await client.saveTaskSkill(projectId, task.id, { changeId: target.changeId, hostId: target.hostId, description, instructions });
        return json({ skillId: skill.id, name: skill.name, scope: skill.scope });
      },
    );
  }

  const editing = task && task.id === taskId && (!agent || task.agent === agent) ? skillEditTarget(task, projectId) : undefined;
  if (task && editing) {
    tool(
      "skill_save_edit",
      "Save your revision of the skill the editor asked you to change. Provide its one-line description and the complete Markdown instructions without frontmatter: this replaces both, so include what stays as well as what changed. Scarlet keeps the name and the earlier version.",
      TaskSkillDraft.shape,
      async ({ description, instructions }) => {
        const { skill } = await client.saveSkillEdit(projectId, task.id, { skillId: editing.skillId, hostId: editing.hostId, description, instructions });
        return json({ skillId: skill.id, name: skill.name, version: skill.version });
      },
    );
  }
}
