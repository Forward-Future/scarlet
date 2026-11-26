import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createProject, newId, timelineFromKeepRanges, type MediaAsset, type Project, type TranscriptSegment, type TranscriptWord } from "@scarlet/timeline";
import type { Task, User } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { badRequest } from "../errors.js";
import { clip, humanDuration, logId } from "../logText.js";
import { ffmpeg } from "../render/ffmpeg.js";
import { errorMessage } from "../util.js";
import { proposeChange } from "./changes.js";
import { storeVersion } from "./timeline.js";
import { getWaveform } from "./waveforms.js";

const SAMPLE_DURATION = 12;
const SAMPLE_FPS = 30;
const SAMPLE_WIDTH = 1280;
const SAMPLE_HEIGHT = 720;
const SAMPLE_FILENAME = "sample-talking-head.mp4";

interface SampleBeat {
  start: number;
  end: number;
  text: string;
}

const SAMPLE_BEATS: SampleBeat[] = [
  { start: 0.4, end: 2.6, text: "Welcome to Scarlet, where you describe the edit you want." },
  { start: 2.8, end: 3.5, text: "Wait, let me—" },
  { start: 5.1, end: 7.6, text: "Scarlet removes false starts, tightens pauses, and keeps every cut easy to review." },
  { start: 9.2, end: 11.4, text: "Press backslash anytime to compare Before and After." },
];

function buildSampleWords(beat: SampleBeat): TranscriptWord[] {
  const tokens = beat.text.split(/\s+/).filter(Boolean);
  const span = beat.end - beat.start;
  const totalWeight = tokens.reduce((sum, token) => sum + Math.max(2, token.length), 0);
  let cursor = beat.start;
  return tokens.map((word, index) => {
    const share = (Math.max(2, word.length) / totalWeight) * span;
    const start = Math.round(cursor * 1000) / 1000;
    const end = index === tokens.length - 1 ? beat.end : Math.round((cursor + share * 0.92) * 1000) / 1000;
    cursor += share;
    return { text: word, start, end, confidence: 0.98 };
  });
}

function buildSampleSegments(): TranscriptSegment[] {
  return SAMPLE_BEATS.map((beat, index) => ({
    id: `seg_sample_${index + 1}`,
    start: beat.start,
    end: beat.end,
    text: beat.text,
    words: buildSampleWords(beat),
  }));
}

/**
 * Synthesize a self-contained 12-second 720p H.264/AAC clip using only built-in FFmpeg filters
 * (no font dependencies). Distinct visual framing cards and speech-like tone envelopes align with
 * the four transcript beats so waveforms, cuts, zoom punch-ins, and Before/After playback all show
 * clearly right away.
 */
async function generateSampleVideo(outputPath: string): Promise<void> {
  // Visual framing: studio backdrop, centered presenter frame, and beat-specific status bars so
  // the false start (red bar, 2.8-3.5 s), dead air, and main takeaway (bright accent) are visually clear.
  const videoFilter = [
    `color=c=0x14151a:s=${SAMPLE_WIDTH}x${SAMPLE_HEIGHT}:r=${SAMPLE_FPS}:d=${SAMPLE_DURATION}`,
    // Subtle outer studio frame & presenter card
    `drawbox=x=160:y=84:w=960:h=552:color=0x1d2028:t=fill`,
    `drawbox=x=160:y=84:w=960:h=552:color=0x323746:t=3`,
    // Stylized silhouette so the 1.15x punch-in zoom is immediately legible
    `drawbox=x=560:y=196:w=160:h=160:color=0x2d3240:t=fill`,
    `drawbox=x=470:y=380:w=340:h=256:color=0x252a36:t=fill`,
    // Beat 1: intro accent
    `drawbox=x=200:y=120:w=220:h=12:color=0xe4e4e7:t=fill:enable='between(t,0.4,2.6)'`,
    // Beat 2: false start indicator (amber/red bar)
    `drawbox=x=200:y=120:w=180:h=12:color=0xef4444:t=fill:enable='between(t,2.8,3.5)'`,
    // Dead air indicator (dim neutral bar)
    `drawbox=x=200:y=120:w=120:h=8:color=0x52525b:t=fill:enable='between(t,3.5,5.0)'`,
    // Beat 3: main takeaway (crisp white bar + bottom framing rule)
    `drawbox=x=200:y=120:w=320:h=12:color=0xffffff:t=fill:enable='between(t,5.1,7.6)'`,
    `drawbox=x=200:y=588:w=880:h=6:color=0xa1a1aa:t=fill:enable='between(t,5.1,7.6)'`,
    // Beat 4: outro wrap-up
    `drawbox=x=200:y=120:w=260:h=12:color=0xd4d4d8:t=fill:enable='between(t,9.2,11.4)'`,
    `format=yuv420p`,
  ].join(",");

  // Audio: clean speech-cadence harmonic bursts aligned to the 4 beats, with quiet room tone (-60 dB) between them.
  const activeMask = SAMPLE_BEATS
    .map(b => `between(t,${b.start.toFixed(2)},${b.end.toFixed(2)})`)
    .join("+");
  const audioExpr = `0.001*sin(2*PI*90*t) + (${activeMask})*(0.14*sin(2*PI*220*t) + 0.08*sin(2*PI*440*t))*(0.55 + 0.45*sin(2*PI*3.5*t))`;

  try {
    await ffmpeg([
      "-y",
      "-f", "lavfi", "-i", videoFilter,
      "-f", "lavfi", "-i", `aevalsrc='${audioExpr}':s=48000:d=${SAMPLE_DURATION}:c=stereo`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      "-shortest",
      outputPath,
    ]);
  } catch (err) {
    const message = errorMessage(err);
    if (/FFmpeg wasn't found|ENOENT|not found/i.test(message)) {
      throw badRequest("ffmpeg_missing", "Install FFmpeg first to create the sample project.");
    }
    throw err;
  }
}

/**
 * Create a self-contained sample project with a generated clip, transcript, initial timeline,
 * and a completed sample editing pass (two dialogue cuts + a 1.15x punch-in) so new users can
 * explore playback, review cards, and Before/After immediately without uploading footage or signing in.
 */
export async function createSampleProject(ctx: Ctx, user: User): Promise<Project> {
  const existingNames = new Set(ctx.repos.projects.summaries().map(p => p.name));
  let name = "Sample project";
  for (let n = 2; existingNames.has(name); n++) name = `Sample project ${n}`;

  const project = ctx.repos.projects.insert(
    createProject(name, { width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT, fps: SAMPLE_FPS, aspect: "16:9", sampleRate: 48000, audioChannels: 2 }),
    true,
  );
  ctx.paths.ensureProject(project.id);

  const mediaId = newId("med");
  const relPath = `${mediaId}.mp4`;
  const mediaPath = join(ctx.paths.media(project.id), relPath);
  const began = performance.now();

  try {
    await generateSampleVideo(mediaPath);
    const [probe, hash] = await Promise.all([
      ctx.render.probeMedia(mediaPath),
      ctx.render.hashFile(mediaPath),
    ]);
    const transcriptId = newId("trn");
    const createdAt = now();

    const asset: MediaAsset = {
      id: mediaId,
      kind: "video",
      name: SAMPLE_FILENAME,
      path: relPath,
      hash,
      duration: probe.duration || SAMPLE_DURATION,
      fps: probe.fps ?? SAMPLE_FPS,
      width: probe.width ?? SAMPLE_WIDTH,
      height: probe.height ?? SAMPLE_HEIGHT,
      hasAudio: probe.hasAudio,
      originalPlaybackType: probe.originalPlaybackType,
      previewClock: probe.previewClock,
      color: probe.color,
      transcriptId,
      provenance: { by: "scarlet", name: "Scarlet", createdAt },
    };

    const media = ctx.repos.projects.putMedia(project.id, asset, "ready");

    ctx.repos.transcripts.put({
      id: transcriptId,
      projectId: project.id,
      mediaId,
      language: "en",
      provider: "sample",
      modelLabel: "Sample transcript",
      segments: buildSampleSegments(),
      createdAt,
    });

    const duration = asset.duration ?? SAMPLE_DURATION;
    const initial = storeVersion(
      ctx,
      project.id,
      timelineFromKeepRanges(project.id, mediaId, [{ start: 0, end: duration }]),
      { parent: null, author: { type: "scarlet", name: "Scarlet" }, description: "Original sample clip" },
    );
    ctx.repos.projects.update(project.id, { head: initial.version });

    const taskId = newId("tsk");
    const runningTask: Task = ctx.repos.tasks.put({
      id: taskId,
      projectId: project.id,
      kind: "edit",
      agent: "claude",
      instruction: "Remove the false start and long pauses, and punch in on the main point.",
      context: {
        message: "Remove the false start and long pauses, and punch in on the main point.",
        branch: project.branch,
        threadId: taskId,
      },
      state: "running",
      createdBy: { type: "human", id: user.id, name: user.name },
      hostId: null,
      changeIds: [],
      question: null,
      summary: null,
      startedAt: createdAt,
      createdAt,
    });

    const agentAuthor = { type: "agent" as const, id: "claude", name: "Scarlet Sample" };

    // Pass edit 1: dialogue cuts (apply the later removal first so the earlier timestamps stay unchanged).
    const cutsResult = proposeChange(ctx, user, project.id, {
      fromVersion: initial.version,
      taskId: runningTask.id,
      intent: "requested",
      autoApprove: true,
      skipRender: true,
      author: agentAuthor,
      description: "Cut false start and tighten pauses",
      reason: "Removed the false start and dead air so the clip flows directly into the main point.",
      ops: [
        { op: "rippleDelete", start: 7.7, end: 9.1 },
        { op: "rippleDelete", start: 2.7, end: 5.0 },
      ],
      timelineEdits: [
        {
          label: "Cut false start and dead air",
          range: { start: 2.7, end: 2.7 },
          reason: "Removed the false start (\"Wait, let me—\") and the 1.6 s silence after it.",
          check: "Listen across the cut into the main takeaway",
          summary: "Removed 2.3 s false start and pause.",
        },
        {
          label: "Tighten pause before wrap-up",
          range: { start: 5.4, end: 5.4 },
          reason: "Trimmed the 1.4 s pause before the closing line.",
          summary: "Trimmed 1.4 s pause.",
        },
      ],
    });

    // Pass edit 2: subtle 1.15x punch-in zoom on the main takeaway clip (now at 2.7-5.4 s).
    const videoTrack = cutsResult.timeline.tracks.find(t => t.kind === "video");
    const takeawayClip = videoTrack?.clips.find(c => c.kind === "media" && Math.abs(c.timelineIn - 2.7) < 0.15);
    if (takeawayClip && takeawayClip.kind === "media") {
      proposeChange(ctx, user, project.id, {
        fromVersion: cutsResult.change.appliedVersion ?? cutsResult.timeline.version,
        taskId: runningTask.id,
        intent: "requested",
        autoApprove: true,
        skipRender: true,
        author: agentAuthor,
        description: "Punch in 1.15× on the main point",
        reason: "Added a subtle punch-in during the main takeaway to give the cut visual energy.",
        ops: [
          {
            op: "updateClip",
            clipId: takeawayClip.id,
            patch: {
              transform: {
                x: 0,
                y: 0,
                scale: 1.15,
                rotation: 0,
                cropLeft: 0,
                cropRight: 0,
                cropTop: 0,
                cropBottom: 0,
              },
            },
          },
        ],
        timelineEdits: [
          {
            label: "Punch in 1.15× on the main point",
            range: { start: takeawayClip.timelineIn, end: takeawayClip.timelineIn + (takeawayClip.sourceOut - takeawayClip.sourceIn) },
            reason: "Subtle 1.15× zoom highlights the core point after the cut.",
            summary: "Added a 1.15× zoom on the main point.",
          },
        ],
      });
    }

    const latestTask = ctx.repos.tasks.get(runningTask.id) ?? runningTask;
    const finished = ctx.repos.tasks.put({
      ...latestTask,
      state: "done",
      summary: "Removed the false start and two long pauses, and added a subtle 1.15× punch-in on the main point.",
      finishedAt: now(),
    });
    ctx.bus.publish({ type: "task.updated", projectId: project.id, task: finished });

    // Pre-build waveform in the background (12 s clip finishes in milliseconds).
    void getWaveform(ctx, { ...media, projectId: project.id }, true)
      .catch(error => ctx.log(`[project] the sample's waveform couldn't be made ahead: ${clip(errorMessage(error))}`));

    const saved = ctx.repos.projects.get(project.id)!;
    ctx.bus.publish({ type: "project.updated", projectId: saved.id, project: saved });
    ctx.log(`[project] sample project ${logId(project.id)} made in ${humanDuration(performance.now() - began)}`);
    return saved;
  } catch (err) {
    ctx.log(`[project] sample project ${logId(project.id)} couldn't be made after ${humanDuration(performance.now() - began)}: ${clip(errorMessage(err))}`);
    ctx.repos.projects.softDelete(project.id);
    await rm(ctx.paths.project(project.id), { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
