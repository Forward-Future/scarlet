/**
 * Fixture data for the native desktop demo. One project with a real-looking cut of the
 * generated public/sample.mp4 (20 s), a few versions (including a branch),
 * changes in every state, notes, renders, tasks, hosts, skills and settings.
 */
import { isDialogueGuide } from "@scarlet/shared";
import type {
  Learning,
  AgentHost,
  ProjectSummary,
  Render,
  ServerSettings,
  Skill,
  SkillVersion,
  Task,
  TaskEvent,
  User,
  VersionSummary,
} from "@scarlet/shared";
import type {
  CaptionClip,
  Change,
  MediaAsset,
  MediaClip,
  Note,
  Project,
  Timeline,
  Transcript,
  TranscriptSegment,
} from "@scarlet/timeline";
import { DEFAULT_PREVIEW_HEIGHT, applyOps, diffTimelines, timelineDuration, type TimelineOp } from "@scarlet/timeline";
import { splitFrontmatter } from "../frontmatter";

const bundledSkillFiles = import.meta.glob<string>("../../../../../skills/*/SKILL.md", { eager: true, query: "?raw", import: "default" });

export interface MockDb {
  me: User;
  projects: Project[];
  summaries: Record<string, ProjectSummary>;
  timelines: Record<string, Timeline>; // by version id
  versions: Record<string, VersionSummary[]>; // by project id
  media: Record<string, MediaAsset[]>; // by project id
  transcripts: Record<string, Transcript>; // by media id
  changes: Change[];
  notes: Note[];
  renders: Render[];
  tasks: Task[];
  taskEvents: Record<string, TaskEvent[]>;
  hosts: AgentHost[];
  skills: Skill[];
  /** Rules Scarlet picked up from requests, waiting for the editor. */
  learnings: Learning[];
  skillVersions: Record<string, SkillVersion[]>;
  settings: ServerSettings;
  invites: string[];
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export const PRJ = "prj_demo";
export const PRJ_SHORT = "prj_short";
export const MED_MAIN = "med_main";
export const MED_MUSIC = "med_music";
export const MED_LOGO = "med_logo";
export const SAMPLE_TRANSCRIPTION_MODEL = "Whisper large-v3";

export function mc(id: string, mediaId: string, sourceIn: number, sourceOut: number, timelineIn: number, extra: Partial<MediaClip> = {}): MediaClip {
  return {
    id,
    kind: "media",
    mediaId,
    sourceIn,
    sourceOut,
    timelineIn,
    speed: 1,
    opacity: 1,
    volume: 1,
    audioFadeIn: 0,
    audioFadeOut: 0,
    videoFadeIn: 0,
    videoFadeOut: 0,
    effects: [],
    enabled: true,
    ...extra,
  };
}

function cap(id: string, timelineIn: number, timelineOut: number, text: string): CaptionClip {
  return { id, kind: "caption", timelineIn, timelineOut, text, enabled: true };
}

function tl(version: string, parent: string | null, name: string, tracks: Timeline["tracks"], createdAt: string): Timeline {
  return { version, parent, projectId: PRJ, name, tracks, markers: [], background: "#000000", createdAt };
}

const track = (id: string, kind: "video" | "audio" | "caption", name: string, clips: Timeline["tracks"][number]["clips"]): Timeline["tracks"][number] => ({
  id,
  kind,
  name,
  muted: false,
  hidden: false,
  clips,
});

export function buildDb(chatLayouts = false): MockDb {
  const me: User = { id: "usr_matt", name: "Matt Berman", createdAt: minutesAgo(60 * 24 * 20) };
  const transcript = buildTranscript();

  const media: MediaAsset[] = [
    {
      id: MED_MAIN,
      kind: "video",
      name: "interview-take2.mp4",
      path: "media/interview-take2.mp4",
      hash: "9f2a…c41d",
      duration: 20,
      fps: 30,
      width: 640,
      height: 360,
      hasAudio: true,
      transcriptId: transcript.id,
      lastTranscription: { completedAt: transcript.createdAt, model: transcript.modelLabel },
    },
    { id: MED_MUSIC, kind: "audio", name: "bed-music.wav", path: "media/bed-music.wav", hash: "11be…7a02", duration: 60, hasAudio: true },
    { id: MED_LOGO, kind: "image", name: "ff-logo.png", path: "media/ff-logo.png", hash: "77c0…e9aa", width: 1024, height: 1024, hasAlpha: true },
  ];

  // --- versions ------------------------------------------------------------
  const v1 = tl("ver_1", null, "Main", [track("v1", "video", "V1", [mc("clip_full", MED_MAIN, 0, 20, 0, { label: "Full take" })]), track("a1", "audio", "A1", [])], minutesAgo(180));

  const v2 = tl(
    "ver_2",
    "ver_1",
    "Main",
    [
      track("v1", "video", "V1", [
        mc("clip_a", MED_MAIN, 2.5, 8, 0, { label: "Cold open" }),
        mc("clip_b", MED_MAIN, 8, 14, 5.5, { label: "Point one" }),
        mc("clip_c", MED_MAIN, 15, 20, 11.5, { label: "Wrap" }),
      ]),
      track("a1", "audio", "A1", []),
    ],
    minutesAgo(120),
  );

  const v2b = tl(
    "ver_2b",
    "ver_1",
    "Alt cold open",
    [
      track("v1", "video", "V1", [
        mc("clip_alt", MED_MAIN, 8, 11, 0, { label: "Hook first" }),
        mc("clip_a2", MED_MAIN, 2.5, 8, 3, { label: "Cold open" }),
        mc("clip_c2", MED_MAIN, 15, 20, 8.5, { label: "Wrap" }),
      ]),
      track("a1", "audio", "A1", []),
    ],
    minutesAgo(110),
  );

  const v3 = tl(
    "ver_3",
    "ver_2",
    "Main",
    [
      track("v1", "video", "V1", [
        mc("clip_a", MED_MAIN, 2.5, 8, 0, { label: "Cold open", videoFadeIn: 0.3 }),
        mc("clip_b", MED_MAIN, 8, 14, 5.5, { label: "Point one" }),
        mc("clip_c", MED_MAIN, 15, 19.5, 11.5, { label: "Wrap", videoFadeOut: 0.5 }),
      ]),
      track("a1", "audio", "A1", [mc("clip_music", MED_MUSIC, 0, 16, 0, { label: "Music bed", volume: 0.2, audioFadeIn: 0.5, audioFadeOut: 1 })]),
      track("c1", "caption", "Captions", [cap("cap_1", 0.2, 2.4, "Welcome back"), cap("cap_2", 5.6, 8, "Three things today")]),
    ],
    minutesAgo(60),
  );

  // chg_ready: trims 0.4 s of pause from the start of clip_b (ripple).
  const v4 = tl(
    "ver_4",
    "ver_3",
    "Main",
    [
      track("v1", "video", "V1", [
        mc("clip_a", MED_MAIN, 2.5, 8, 0, { label: "Cold open", videoFadeIn: 0.3 }),
        mc("clip_b", MED_MAIN, 8.4, 14, 5.5, { label: "Point one" }),
        mc("clip_c", MED_MAIN, 15, 19.5, 11.1, { label: "Wrap", videoFadeOut: 0.5 }),
      ]),
      track("a1", "audio", "A1", [mc("clip_music", MED_MUSIC, 0, 15.6, 0, { label: "Music bed", volume: 0.2, audioFadeIn: 0.5, audioFadeOut: 1 })]),
      track("c1", "caption", "Captions", [cap("cap_1", 0.2, 2.4, "Welcome back"), cap("cap_2", 5.6, 7.6, "Three things today")]),
    ],
    minutesAgo(12),
  );

  // chg_rendering: adds a logo lower-third over the intro.
  const v5 = tl(
    "ver_5",
    "ver_3",
    "Main",
    [
      ...v3.tracks.slice(0, 1),
      track("v2", "video", "V2", [
        mc("clip_logo", MED_LOGO, 0, 3, 0.5, { label: "Lower third", transform: { x: -0.32, y: 0.3, scale: 0.18, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 }, videoFadeIn: 0.25, videoFadeOut: 0.25 }),
      ]),
      ...v3.tracks.slice(1),
    ],
    minutesAgo(4),
  );

  // chg_pause_v1: the first, too-aggressive attempt at the pause (cut 0.8 s).
  const v4a = tl(
    "ver_4a",
    "ver_3",
    "Main",
    [
      track("v1", "video", "V1", [
        mc("clip_a", MED_MAIN, 2.5, 8, 0, { label: "Cold open", videoFadeIn: 0.3 }),
        mc("clip_b", MED_MAIN, 8.8, 14, 5.5, { label: "Point one" }),
        mc("clip_c", MED_MAIN, 15, 19.5, 10.7, { label: "Wrap", videoFadeOut: 0.5 }),
      ]),
      ...v3.tracks.slice(1),
    ],
    minutesAgo(14),
  );

  // chg_fillers: six filler words removed, as real ops (back to front, so each is in v3's coordinates).
  const FILLER_CUTS: Array<{ start: number; end: number }> = [
    { start: 0.8, end: 1.1 },
    { start: 3.0, end: 3.3 },
    { start: 6.4, end: 6.8 },
    { start: 9.1, end: 9.35 },
    { start: 12.6, end: 13.0 },
    { start: 14.8, end: 15.1 },
  ];
  const fillerOps: TimelineOp[] = [...FILLER_CUTS].reverse().map((r) => ({ op: "rippleDelete", start: r.start, end: r.end }));
  const v6 = { ...applyOps(v3, fillerOps), version: "ver_6", parent: "ver_3", createdAt: minutesAgo(8) };
  const fillerSpots = diffTimelines(v3, v6).spots;

  const timelines: Record<string, Timeline> = { ver_1: v1, ver_2: v2, ver_2b: v2b, ver_3: v3, ver_4: v4, ver_4a: v4a, ver_5: v5, ver_6: v6 };

  const agentClaude = { type: "agent" as const, id: "claude", name: "Claude Code", model: "opus" };
  const agentCodex = { type: "agent" as const, id: "codex", name: "Codex", model: "gpt-5-codex" };
  const agentGemini = { type: "agent" as const, id: "gemini", name: "Gemini CLI", model: "gemini-2.5-pro" };
  const humanMatt = { type: "human" as const, id: me.id, name: me.name };

  const versions: VersionSummary[] = [
    { version: "ver_1", parent: null, name: "Main", author: humanMatt, changeId: null, description: "Imported full take", duration: timelineDuration(v1), isHead: false, createdAt: v1.createdAt },
    { version: "ver_2", parent: "ver_1", name: "Main", author: agentClaude, changeId: "chg_approved_1", description: "Cut the false start and the tangent at 14 s", duration: timelineDuration(v2), isHead: false, createdAt: v2.createdAt },
    { version: "ver_2b", parent: "ver_1", name: "Alt cold open", author: agentGemini, changeId: "chg_proposed", description: "Try opening on the hook", duration: timelineDuration(v2b), isHead: false, createdAt: v2b.createdAt },
    { version: "ver_3", parent: "ver_2", name: "Main", author: agentClaude, changeId: "chg_approved_2", description: "Tighten the wrap, add music bed and captions", duration: timelineDuration(v3), isHead: true, createdAt: v3.createdAt },
  ];

  const project: Project = {
    id: PRJ,
    name: "FF Weekly — AI agents interview",
    settings: { fps: 30, width: 1920, height: 1080, aspect: "16:9", sampleRate: 48000, audioChannels: 2 },
    media,
    head: "ver_3",
    createdAt: minutesAgo(60 * 24 * 2),
    updatedAt: minutesAgo(4),
  };

  const shortTl = tl("ver_s1", null, "Main", [track("v1", "video", "V1", [mc("clip_s", MED_MAIN, 0, 12, 0, { label: "Hook" })]), track("a1", "audio", "A1", [])], minutesAgo(400));
  shortTl.projectId = PRJ_SHORT;
  timelines.ver_s1 = shortTl;
  const projectShort: Project = {
    id: PRJ_SHORT,
    name: "Techvestigator — GPU shortage short",
    settings: { fps: 30, width: 1080, height: 1920, aspect: "9:16", sampleRate: 48000, audioChannels: 2 },
    media: [{ ...media[0]!, id: "med_short_main", transcriptId: "tr_short", name: "gpu-short-vo.mp4", path: "media/gpu-short-vo.mp4" }],
    head: "ver_s1",
    createdAt: minutesAgo(60 * 24 * 5),
    updatedAt: minutesAgo(400),
  };

  const summaries: Record<string, ProjectSummary> = {
    [PRJ]: { id: PRJ, name: project.name, settings: project.settings, head: project.head, mediaCount: 3, pendingChanges: 2, openNotes: 2, updatedAt: project.updatedAt, createdAt: project.createdAt },
    [PRJ_SHORT]: { id: PRJ_SHORT, name: projectShort.name, settings: projectShort.settings, head: projectShort.head, mediaCount: 1, pendingChanges: 0, openNotes: 0, updatedAt: projectShort.updatedAt, createdAt: projectShort.createdAt },
  };


  // --- renders ---------------------------------------------------------------
  const rnd = (id: string, version: string, kind: Render["kind"], state: Render["state"], extra: Partial<Render> = {}): Render => ({
    id,
    projectId: PRJ,
    version,
    kind,
    range: null,
    key: `k_${id}`,
    path: state === "done" ? `renders/${id}.mp4` : null,
    state,
    progress: state === "done" ? 1 : 0,
    width: Math.round(project.settings.width * DEFAULT_PREVIEW_HEIGHT / project.settings.height / 2) * 2,
    height: DEFAULT_PREVIEW_HEIGHT,
    createdAt: minutesAgo(10),
    ...extra,
  });
  const renders: Render[] = [
    rnd("rnd_full_head", "ver_3", "full", "done", { durationSeconds: 16, finishedAt: minutesAgo(50) }),
    ...fillerSpots.flatMap((s, i) => [
      rnd(`rnd_fb${i}`, "ver_3", "segment", "done", { range: { start: Math.max(0, s.before.start - 1.5), end: s.before.end + 1.5 }, changeId: "chg_fillers", durationSeconds: 3 }),
      rnd(`rnd_fa${i}`, "ver_6", "segment", "done", { range: { start: Math.max(0, s.after.start - 1.5), end: s.after.end + 1.5 }, changeId: "chg_fillers", durationSeconds: 3 }),
    ]),
    rnd("rnd_pb1", "ver_3", "segment", "done", { range: { start: 3.5, end: 7.7 }, changeId: "chg_pause_v1", durationSeconds: 4.2 }),
    rnd("rnd_pa1", "ver_4a", "segment", "done", { range: { start: 3.5, end: 6.9 }, changeId: "chg_pause_v1", durationSeconds: 3.4 }),
    rnd("rnd_b1", "ver_3", "segment", "done", { range: { start: 3.5, end: 7.7 }, changeId: "chg_ready", durationSeconds: 4.2 }),
    rnd("rnd_a1", "ver_4", "segment", "done", { range: { start: 3.5, end: 7.3 }, changeId: "chg_ready", durationSeconds: 3.8 }),
    rnd("rnd_b2", "ver_3", "segment", "done", { range: { start: 0, end: 5 }, changeId: "chg_rendering", durationSeconds: 5 }),
    rnd("rnd_a2", "ver_5", "segment", "running", { range: { start: 0, end: 5 }, changeId: "chg_rendering", progress: 0.42 }),
    rnd("rnd_b3", "ver_2", "segment", "done", { range: { start: 10, end: 16.5 }, changeId: "chg_rejected", durationSeconds: 6.5 }),
    rnd("rnd_a3", "ver_2", "segment", "done", { range: { start: 10, end: 15.6 }, changeId: "chg_rejected", durationSeconds: 5.6 }),
  ];

  // --- changes ---------------------------------------------------------------
  const changes: Change[] = [
    {
      id: "chg_ready",
      projectId: PRJ,
      fromVersion: "ver_3",
      toVersion: "ver_4",
      description: "Trim the 0.4 s pause before “three things” and ripple the wrap earlier",
      author: agentClaude,
      noteIds: ["note_pause", "note_pause_v2"],
      ranges: [{ start: 5.0, end: 6.2 }],
      state: "ready",
      renders: [{ range: { start: 5.0, end: 6.2 }, before: "rnd_b1", after: "rnd_a1" }],
      taskId: "task_done",
      createdAt: minutesAgo(12),
      updatedAt: minutesAgo(11),
    },
    {
      id: "chg_fillers",
      projectId: PRJ,
      fromVersion: "ver_3",
      toVersion: "ver_6",
      description: "Cut 6 filler words (um, uh, you know)",
      author: agentClaude,
      noteIds: [],
      ranges: fillerSpots.map((s) => s.after),
      ...(chatLayouts && { taskId: "task_chat_batch" }),
      ops: fillerOps as unknown as Array<Record<string, unknown>>,
      state: "ready",
      renders: fillerSpots.map((s, i) => ({ range: { start: Math.max(0, s.after.start - 1.5), end: s.after.end + 1.5 }, before: `rnd_fb${i}`, after: `rnd_fa${i}` })),
      createdAt: minutesAgo(8),
      updatedAt: minutesAgo(7),
    },
    {
      id: "chg_pause_v1",
      projectId: PRJ,
      fromVersion: "ver_3",
      toVersion: "ver_4a",
      description: "Trim the pause before “three things” (cut 0.8 s)",
      author: agentClaude,
      noteIds: ["note_pause"],
      ranges: [{ start: 5.0, end: 6.2 }],
      state: "rejected",
      renders: [{ range: { start: 5.0, end: 6.2 }, before: "rnd_pb1", after: "rnd_pa1" }],
      decidedBy: humanMatt,
      createdAt: minutesAgo(14),
      updatedAt: minutesAgo(13),
    },
    {
      id: "chg_rendering",
      projectId: PRJ,
      fromVersion: "ver_3",
      toVersion: "ver_5",
      description: "Add the Forward Future lower-third over the first three seconds",
      author: agentCodex,
      noteIds: [],
      ranges: [{ start: 0.5, end: 3.5 }],
      state: "rendering",
      renders: [{ range: { start: 0.5, end: 3.5 }, before: "rnd_b2", after: "rnd_a2" }],
      taskId: "task_waiting",
      createdAt: minutesAgo(4),
      updatedAt: minutesAgo(1),
    },
    {
      id: "chg_proposed",
      projectId: PRJ,
      fromVersion: "ver_1",
      toVersion: "ver_2b",
      description: "Alternate: open on the hook, then the cold open",
      author: agentGemini,
      noteIds: [],
      ranges: [{ start: 0, end: 13.5 }],
      state: "proposed",
      renders: [],
      createdAt: minutesAgo(110),
      updatedAt: minutesAgo(110),
    },
    {
      id: "chg_approved_2",
      projectId: PRJ,
      fromVersion: "ver_2",
      toVersion: "ver_3",
      description: "Tighten the wrap, add music bed and captions",
      timelineEdits: [
        { label: "music bed", range: { start: 0, end: 16 } },
        { label: "captions", range: { start: 0.2, end: 2.4 } },
        { label: "wrap", range: { start: 11.5, end: 16 } },
      ],
      author: agentClaude,
      noteIds: [],
      ...(chatLayouts && { taskId: "task_chat_direct" }),
      ranges: [{ start: 0, end: 16.5 }],
      state: "approved",
      renders: [],
      createdAt: minutesAgo(65),
      updatedAt: minutesAgo(60),
    },
    {
      id: "chg_approved_1",
      projectId: PRJ,
      fromVersion: "ver_1",
      toVersion: "ver_2",
      description: "Cut the false start and the tangent at 14 s",
      author: agentClaude,
      noteIds: [],
      ranges: [{ start: 0, end: 16.5 }],
      state: "approved",
      renders: [],
      createdAt: minutesAgo(125),
      updatedAt: minutesAgo(120),
    },
    {
      id: "chg_rejected",
      projectId: PRJ,
      fromVersion: "ver_2",
      toVersion: "ver_2",
      description: "Speed up the wrap to 1.2x",
      author: agentGemini,
      noteIds: [],
      ranges: [{ start: 11.5, end: 16.5 }],
      state: "rejected",
      renders: [{ range: { start: 11.5, end: 16.5 }, before: "rnd_b3", after: "rnd_a3" }],
      createdAt: minutesAgo(90),
      updatedAt: minutesAgo(85),
    },
    {
      id: "chg_failed",
      projectId: PRJ,
      fromVersion: "ver_3",
      toVersion: "ver_3",
      description: "Replace the music bed with the new sting",
      author: agentCodex,
      noteIds: [],
      ranges: [{ start: 0, end: 16 }],
      state: "failed",
      renders: [],
      error: "Scarlet couldn’t render this part of the video: try once more, or export the logs from Settings → Advanced to report it.",
      createdAt: minutesAgo(30),
      updatedAt: minutesAgo(29),
    },
  ];

  // --- notes -------------------------------------------------------------------
  const notes: Note[] = [
    {
      id: "note_pause",
      projectId: PRJ,
      version: "ver_3",
      time: 5.6,
      clipIds: ["clip_b"],
      text: "Tighten the pause before “three things”, it runs about half a second long.",
      voiceTranscript: "um the pause here before three things is too long, tighten it up like half a second",
      author: humanMatt,
      assignedTo: "claude",
      state: "in_progress",
      createdAt: minutesAgo(15),
      updatedAt: minutesAgo(12),
    },
    {
      id: "note_pause_v2",
      projectId: PRJ,
      version: "ver_4a",
      time: 5.0,
      end: 6.2,
      clipIds: [],
      text: "Too much, it feels jumpy now. Keep about half a second of the pause.",
      author: humanMatt,
      assignedTo: "claude:opus",
      changeId: "chg_pause_v1",
      state: "in_progress",
      createdAt: minutesAgo(13),
      updatedAt: minutesAgo(12),
    },
    {
      id: "note_logo",
      projectId: PRJ,
      version: "ver_3",
      time: 15.2,
      clipIds: ["clip_c"],
      text: "Can we end on the logo instead of a fade to black?",
      author: humanMatt,
      state: "open",
      createdAt: minutesAgo(40),
      updatedAt: minutesAgo(40),
    },
    {
      id: "note_music",
      projectId: PRJ,
      version: "ver_2",
      time: 0.8,
      end: 3.0,
      clipIds: ["clip_a"],
      text: "Music bed under the open, keep it low.",
      author: humanMatt,
      assignedTo: "claude",
      state: "resolved",
      createdAt: minutesAgo(70),
      updatedAt: minutesAgo(60),
    },
  ];

  // --- tasks -------------------------------------------------------------------
  const chatTasks: Task[] = chatLayouts ? [
    {
      id: "task_chat_direct",
      projectId: PRJ,
      kind: "edit",
      agent: "claude",
      model: "opus",
      instruction: "Add a quiet music bed, caption the opening, and tighten the wrap so we end on the point.",
      context: { version: "ver_2" },
      state: "done",
      createdBy: humanMatt,
      hostId: "host_matt",
      changeIds: ["chg_approved_2"],
      question: null,
      summary: "The music sits under the voice, and the captions come in on the first line. Check the wrap to see how the ending lands.",
      createdAt: minutesAgo(67),
      startedAt: minutesAgo(66),
      finishedAt: minutesAgo(60),
    },
    {
      id: "task_chat_batch",
      projectId: PRJ,
      kind: "edit",
      agent: "claude",
      model: "opus",
      instruction: "Find the filler words and let me check each proposed cut before applying the pass.",
      context: { version: "ver_3", reviewAllCuts: true },
      state: "done",
      createdBy: humanMatt,
      hostId: "host_matt",
      changeIds: ["chg_fillers"],
      question: null,
      summary: "I found six spots to review.",
      createdAt: minutesAgo(10),
      startedAt: minutesAgo(9),
      finishedAt: minutesAgo(7),
    },
  ] : [];
  const tasks: Task[] = [
    ...chatTasks,
    {
      id: "task_running",
      projectId: PRJ,
      kind: "edit",
      agent: "claude",
      model: "opus",
      instruction: "Find every filler word in the wrap and propose cuts, keeping the sentence rhythm.",
      context: { version: "ver_3", clipIds: ["clip_c"] },
      state: "running",
      createdBy: humanMatt,
      hostId: "host_matt",
      changeIds: [],
      question: null,
      summary: null,
      createdAt: minutesAgo(2),
      startedAt: minutesAgo(1.5),
    },
    {
      id: "task_waiting",
      projectId: PRJ,
      kind: "edit",
      agent: "codex",
      model: "gpt-5-codex",
      instruction: "Add the Forward Future lower-third over the first three seconds.",
      context: { version: "ver_3", time: 0.5 },
      state: "waiting_for_user",
      createdBy: humanMatt,
      hostId: "host_matt",
      changeIds: ["chg_rendering"],
      question: "Should the lower-third use the Forward Future purple (#9333ea) or stay white on the dark frame?",
      summary: null,
      createdAt: minutesAgo(6),
      startedAt: minutesAgo(5),
    },
    {
      id: "task_done",
      projectId: PRJ,
      kind: "note",
      agent: "claude",
      model: "opus",
      instruction: "Tighten the pause before “three things”, it runs about half a second long.",
      context: { version: "ver_3", noteIds: ["note_pause"], time: 5.6, clipIds: ["clip_b"] },
      state: "done",
      createdBy: humanMatt,
      hostId: "host_matt",
      changeIds: ["chg_ready"],
      question: null,
      summary: "Trimmed 0.4 s from the head of “Point one” and rippled the wrap and music bed earlier. Captions re-timed.",
      createdAt: minutesAgo(15),
      startedAt: minutesAgo(14),
      finishedAt: minutesAgo(11),
    },
  ];

  const taskEvents: Record<string, TaskEvent[]> = {
    task_running: [
      { id: "ev1", taskId: "task_running", at: minutesAgo(1.5), type: "log", text: "Loading project context and skills (dialogue-pass, smooth-audio-cuts)" },
      { id: "ev2", taskId: "task_running", at: minutesAgo(1.3), type: "tool", text: "transcript.get range=11.5–16 granularity=word" },
      { id: "ev3", taskId: "task_running", at: minutesAgo(1.1), type: "log", data: { kind: "editor_progress" }, text: "I found three filler words near the end of the clip." },
    ],
    task_waiting: [
      { id: "ev4", taskId: "task_waiting", at: minutesAgo(5), type: "log", text: "Reading brand skill ff-brand-lower-thirds" },
      { id: "ev5", taskId: "task_waiting", at: minutesAgo(4.5), type: "tool", text: "timeline.propose description=\"Add the Forward Future lower-third…\"" },
      { id: "ev6", taskId: "task_waiting", at: minutesAgo(4), type: "change", text: "Proposed change chg_rendering", data: { changeId: "chg_rendering" } },
      { id: "ev7", taskId: "task_waiting", at: minutesAgo(3), type: "question", text: "Should the lower-third use the Forward Future purple (#9333ea) or stay white on the dark frame?" },
    ],
    task_done: [
      { id: "ev8", taskId: "task_done", at: minutesAgo(14), type: "tool", text: "waveform.get range=5–7" },
      { id: "ev9", taskId: "task_done", at: minutesAgo(13), type: "log", text: "Silence from 8.02 to 8.41 in source; trimming clip_b head by 0.4 s" },
      { id: "ev10", taskId: "task_done", at: minutesAgo(12), type: "change", text: "Proposed change chg_ready", data: { changeId: "chg_ready" } },
    ],
  };

  const hosts: AgentHost[] = [
    {
      id: "host_matt",
      userId: "usr_matt",
      name: "Matt’s MacBook Pro",
      platform: "darwin-arm64",
      online: true,
      lastSeenAt: minutesAgo(0.1),
      agents: [
        { id: "claude", installed: true, loggedIn: true, version: "2.1.4", model: "opus", models: ["opus", "sonnet", "haiku", "fable"], modelLabels: { opus: "Opus 5.5", sonnet: "Sonnet 5.5", haiku: "Haiku 5.5", fable: "Fable 5.1" } },
        { id: "codex", installed: true, loggedIn: true, version: "0.52.0", model: "gpt-6.1-sol", models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna"] },
        { id: "gemini", installed: true, loggedIn: false, version: "0.9.1" },
      ],
    },
    {
      id: "host_studio",
      userId: "usr_matt",
      name: "Studio PC",
      platform: "win32-x64",
      online: false,
      lastSeenAt: minutesAgo(60 * 9),
      agents: [{ id: "codex", installed: true, loggedIn: true, version: "0.51.0", model: "gpt-6.1-sol", models: ["gpt-6.1-sol"] }],
    },
  ];

  const mkSkill = (content: string, extra: Partial<Skill> = {}): Skill => {
    const { frontmatter } = splitFrontmatter(content);
    if (!frontmatter.name) throw new Error("Demo skill is missing its name");
    return {
      id: `skl_${frontmatter.name}`,
      name: frontmatter.name,
      description: frontmatter.description ?? "",
      content,
      scope: "team",
      ownerId: null,
      projectId: null,
      agents: [],
      enabled: true,
      version: frontmatter.name === "dialogue-pass" ? 2 : 1,
      createdAt: minutesAgo(60 * 24 * 10),
      updatedAt: minutesAgo(60 * 24 * 3),
      ...extra,
    };
  };
  const skills = Object.values(bundledSkillFiles).map(content => mkSkill(content, { source: "bundled" }));
  const skillVersions: Record<string, SkillVersion[]> = {};
  for (const s of skills) {
    const list: SkillVersion[] = [];
    for (let v = 1; v <= s.version; v++) {
      list.push({ version: v, content: v === s.version ? s.content : s.content.replace("# ", `# (v${v}) `), author: v === 1 ? humanMatt : agentClaude, createdAt: minutesAgo(60 * 24 * (10 - v)) });
    }
    skillVersions[s.id] = list;
  }

  // Two rules picked up from the sample's requests, so the demo shows what waits in Learnings.
  const dialogueSkill = skills.find(isDialogueGuide);
  if (!dialogueSkill) throw new Error("Demo is missing its dialogue guide");
  const learnings: Learning[] = [
    { id: "lrn_pause", projectId: PRJ, rule: "Bring every pause between sentences down to about a quarter second.", said: "Tighten the pause before “three things”. A quarter second between sentences, always.",
      taskId: "task_done", skillId: dialogueSkill.id, state: "suggested", createdAt: minutesAgo(11),
      // What the sample's dialogue skill says that the rule would change, as a check quotes it.
      replaces: ["Match a pause to the exchange around it."] },
    { id: "lrn_laugh", projectId: PRJ, rule: "Keep a laugh in. Cut only the dead air after it.", said: "Don’t cut the laugh.",
      taskId: "task_done", skillId: dialogueSkill.id, state: "suggested", createdAt: minutesAgo(10) },
  ];

  const settings: ServerSettings = {
    editingTools: {},
    transcription: { provider: "whispercpp", openaiModel: "whisper-1", whisperCppPath: "/opt/whisper.cpp/main", whisperModelPath: "/opt/whisper.cpp/models/ggml-large-v3.bin", language: "en" },
    noteCleanup: { enabled: true, provider: "anthropic", model: "claude-haiku-4-5" },
    render: { handleSeconds: 1.5, previewHeight: DEFAULT_PREVIEW_HEIGHT, concurrency: 2, hwaccel: "auto" },
    defaultAgent: "claude",
    dialogue: { aiCuts: { pause: "cut", filler: "cut", retake: "cut", coaching: "cut" }, pauseTightness: "natural", crossfadeFrames: 2 },
  };

  return {
    me,
    projects: [project, projectShort],
    summaries,
    timelines,
    versions: {
      [PRJ]: versions,
      [PRJ_SHORT]: [{ version: "ver_s1", parent: null, name: "Main", author: humanMatt, changeId: null, description: "Imported voice-over", duration: 12, isHead: true, createdAt: shortTl.createdAt }],
    },
    media: { [PRJ]: media, [PRJ_SHORT]: projectShort.media },
    transcripts: { [MED_MAIN]: transcript, med_short_main: { ...transcript, id: "tr_short", mediaId: "med_short_main" } },
    changes,
    notes,
    renders,
    tasks,
    taskEvents,
    hosts,
    skills,
    learnings,
    skillVersions,
    settings,
    invites: [],
  };
}

const SCRIPT = [
  "So, um, let me start that again.",
  "Welcome back. Today I want to talk about why agents are finally useful for editing.",
  "Three things today: the cut list, partial renders, and the review loop.",
  "First, the cut list is the source of truth, not the MP4.",
  "Wait, hold on, let me, let me rephrase that part about the tangent.",
  "Second, you only re-render what changed, which makes review fast.",
  "And third, you know, the editor talks back to the agent in the same place.",
];

/** 20 s of word-timed speech over the sample: ~2.6 words/s with sentence gaps. */
export function buildTranscript(): Transcript {
  const segments: TranscriptSegment[] = [];
  let t = 0.3;
  SCRIPT.forEach((sentence, i) => {
    const words = sentence.split(" ");
    const start = t;
    const segWords = words.map((text) => {
      const dur = 0.18 + Math.min(0.32, text.replace(/[^a-z]/gi, "").length * 0.045);
      const w = { text, start: Number(t.toFixed(3)), end: Number((t + dur).toFixed(3)) };
      t += dur + 0.06;
      return w;
    });
    t += 0.35;
    segments.push({ id: `seg_${i + 1}`, start, end: segWords[segWords.length - 1]!.end, text: sentence, speaker: "Matt", words: segWords });
  });
  return { id: "tr_main", mediaId: MED_MAIN, language: "en", provider: "whispercpp", modelLabel: SAMPLE_TRANSCRIPTION_MODEL, segments, createdAt: minutesAgo(60 * 24) };
}
