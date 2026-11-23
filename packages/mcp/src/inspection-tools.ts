import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod/v3";
import {
  CutReviewOptions,
  isProjectEditTask,
  ScarletApiError,
  SheetOptions,
  SheetRequest,
  SoundPictureOptions,
  SOURCE_AUDIO_IN_RESULT,
  SOURCE_AUDIO_MOST,
  SourceAudioOptions,
  toolWait,
  type AgentCapabilities,
  type InspectionResult,
  type Listener,
  type InspectionWindow,
  type ScarletClient,
  type Task,
  type TaskEvent,
} from "@scarlet/shared";
import { timelineDuration, type MediaClip, type TimeRange } from "@scarlet/timeline";
import { colorEvidence, pct1 } from "./analysis.js";
import { createAudioOption, percentBox } from "./mcp-schema.js";
import type { MediaSession } from "./media-session.js";
import { eachRecording, RecordingList, recordingsAsked, requireMediaAsset, type SessionErrorHelpers } from "./media-state.js";
import { PictureBatches, type PictureRequest, type PreparedPictures } from "./picture-batches.js";
import type { RecordingAreas } from "./show-area.js";
import { json, notePreparing, text, type ToolRegistrar, type ToolResult } from "./tool-result.js";

export interface InspectionToolsDeps {
  tool: ToolRegistrar;
  client: ScarletClient;
  projectId: string;
  taskId?: string;
  task?: Task;
  caps: AgentCapabilities;
  fetchImpl: typeof fetch;
  session: MediaSession;
  errors: SessionErrorHelpers;
  scanScopes: ReadonlyMap<string, number>;
  waitLeft(margin: number, most?: number): number;
  readPassage(version: string, range: TimeRange, edges?: boolean): void;
  postEvent(ev: Omit<TaskEvent, "taskId">): Promise<{ posted: boolean; error?: string }>;
  /** Writes a file into the task folder and returns its path, for a model that hears a file it opens there. */
  writeArtifact?(path: string, data: Uint8Array): Promise<string>;
  /** The model that listens for this request when its own model can't hear (`listen`). */
  listener?: Listener;
}

/**
 * How the model hears a recording, if it can: as audio in a tool's result, or as a WAV file Scarlet writes to its task
 * folder for it to open with its harness's own file viewer (`audioFiles`), which can be longer.
 */
export function listening(caps: AgentCapabilities, canWrite: boolean): { by: "result" | "file"; most: number } | undefined {
  if (caps.audio) return { by: "result", most: SOURCE_AUDIO_IN_RESULT };
  if (caps.audioFiles && caps.files && canWrite) return { by: "file", most: SOURCE_AUDIO_MOST };
  return undefined;
}

/**
 * Deliver a base64 WAV to a hearing model: inline for a harness that forwards MCP audio blocks, or written as a WAV
 * file to the task folder for a harness whose file viewer hears audio (`audioFiles`).
 */
export async function deliverWav(
  listen: { by: "result" | "file" },
  wav: string,
  name: string,
  meta: Record<string, unknown>,
  how: string,
  writeArtifact?: (path: string, data: Uint8Array) => Promise<string>,
): Promise<ToolResult["content"]> {
  if (listen.by !== "file") return [{ type: "audio", mimeType: "audio/wav", data: wav }];
  const file = await writeArtifact!(name, Buffer.from(wav, "base64"));
  return [{ type: "text", text: JSON.stringify({ listen: file, ...meta, how }) }];
}

export function registerInspectionTools(deps: InspectionToolsDeps) {
  const { tool, client, projectId, taskId, task, caps, fetchImpl, session, errors, scanScopes, waitLeft, readPassage, postEvent, writeArtifact, listener } = deps;
  const { getProject, getHeader, nextBaseAsk, moveBase, baseTimeline, transcriptWords } = session;
  const { withoutOnce } = errors;
  const listen = listening(caps, !!writeArtifact);
  const defaultAudio = listen?.by === "file";
  const audioOption = createAudioOption(!!listen, defaultAudio);

  /** One frame of a source recording, or of `area` of it in percent, `width` pixels wide. */
  async function sourceFrame(mediaId: string, t: number, width: number, area?: readonly number[], grid?: boolean) {
    const res = await client.withResource("media", mediaId, async path => {
      const url = client.url(`${path}/frame?t=${t}&w=${width}${area ? `&area=${area.join(",")}` : ""}${grid ? "&grid=1" : ""}`);
      const headers: Record<string, string> = {};
      if (client.token) headers.Authorization = `Bearer ${client.token}`;
      const response = await fetchImpl(url, { headers });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
        throw new ScarletApiError(response.status, body?.error?.code ?? "frame_failed", body?.error?.message ?? response.statusText);
      }
      return response;
    });
    return { data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType: res.headers.get("content-type")?.split(";")[0] || "image/jpeg" };
  }

  // -- project & media ------------------------------------------------------

  tool(
    "project_get",
    "Get the project: settings (fps, width x height, aspect), every media asset (id, name, kind, duration s, fps, size, hasAudio, hasTranscript, provenance of generated assets, for a graphic Scarlet drew the page it was drawn from, relative to the project's folder, and color when the file declares HDR, which Scarlet already tone-maps to SDR, a camera Log curve, which stays flat as shot until a look is applied with the lut effect, or other colour tags), the head version, the edit's duration, and a per-track summary. For an assigned task, editContext contains the editor’s recorded selection, change or cut index, and note IDs when supplied. Media ids are what transcript, waveform and clip tools take as mediaId. For clip-level detail use timeline_get.",
    {},
    async () => {
      const asked = nextBaseAsk();
      const detail = await client.workspace(projectId);
      const media = detail.project.media.map((m) => ({
        id: m.id, name: m.name, kind: m.kind, duration: m.duration, fps: m.fps, width: m.width, height: m.height,
        hasAudio: m.hasAudio, hasTranscript: Boolean(m.transcriptId), ...(m.provenance && { provenance: m.provenance }), ...(m.graphic && { graphic: m.graphic }),
        ...(colorEvidence(m.color) && { color: colorEvidence(m.color) }),
      }));
      const tl = detail.timeline;
      moveBase(tl, asked);
      return json({
        id: detail.project.id,
        name: detail.project.name,
        settings: detail.project.settings,
        head: detail.project.head,
        editContext: task && { ...task.context, dialogueRange: session.localRange },
        duration: tl ? timelineDuration(tl) : 0,
        media,
        tracks: tl ? tl.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, clips: t.clips.length, muted: t.muted, hidden: t.hidden })) : [],
      });
    },
  );

  /** Whether the preview renders an inspection waits on are all done. One that failed or was cancelled throws. */
  async function rendersDone(ids: string[]) {
    const jobs = await Promise.all(ids.map(id => client.render(id)));
    const failed = jobs.find(({ render }) => render.state === "failed" || render.state === "cancelled");
    if (failed) throw new Error(failed.render.errorDetail || failed.render.error || "Inspection preview was cancelled.");
    return jobs.every(({ render }) => render.state === "done");
  }

  async function inspect(request: () => Promise<InspectionResult>, onReady?: (windows: InspectionWindow[]) => void, batchSignal?: AbortSignal): Promise<ToolResult> {
    let result = await request();
    if (result.state === "preparing") {
      const deadline = Date.now() + (batchSignal ? 120_000 : 10_000);
      const ids = result.renderIds;
      while (Date.now() < deadline) {
        if (await rendersDone(ids)) {
          result = await request();
          break;
        }
        await delay(300, undefined, { signal: batchSignal });
      }
    }
    if (result.state === "preparing" && batchSignal) throw new Error("The preview is still preparing. Retry this window.");
    if (result.state === "preparing") {
      notePreparing();
      return text("Scarlet is preparing the inspection windows. Repeat this call to collect them. Render IDs: " + result.renderIds.join(", "));
    }
    onReady?.(result.windows);
    const content: ToolResult["content"] = [];
    if (result.total !== undefined) content.push({ type: "text", text: JSON.stringify({
      index: result.index, total: result.total, newEvents: result.newEvents,
      comparison: result.newEvents
        ? "Potential new events on the proposed timeline." + (caps.images ? " Check the images before acting." : "")
        : "Only one side has playable footage.",
    }) });
    for (const { jpeg, wav, ...window } of result.windows) {
      content.push({ type: "text", text: JSON.stringify(window) });
      if (caps.images) content.push({ type: "image", mimeType: "image/jpeg", data: jpeg });
      if (listen && wav) {
        const tag = `${window.id}-${window.label.toLowerCase().replace(/\W+/g, "-")}-${window.range.start.toFixed(2)}-${window.range.end.toFixed(2)}`;
        const how = window.label === "After"
          ? "Open this WAV file with your own file viewer to hear the rendered join as the viewer will hear it."
          : "Open this WAV file with your own file viewer to hear the original passage around this edge.";
        content.push(...await deliverWav(listen, wav, `listen/review-${tag}.wav`,
          { label: window.label, version: window.id, range: window.range }, how, writeArtifact));
      }
    }
    return { content };
  }

  const reviewPassages = new Set<string>();
  async function pinPictures(requests: PictureRequest[]) {
    if (!requests.some(r => !r.mediaId && (!r.version || r.version === "head"))) return requests;
    const { project } = await getHeader();
    if (!project.head) throw new Error("The timeline has no footage yet.");
    return requests.map(r => !r.mediaId && (!r.version || r.version === "head") ? { ...r, version: project.head! } : r);
  }
  async function preparePictures(request: PictureRequest, signal?: AbortSignal): Promise<PreparedPictures> {
    let windows: InspectionWindow[] = [];
    const result = await inspect(() => client.contactSheet(projectId, request, signal), ready => { windows = ready; }, signal);
    return { request, result, windows };
  }
  async function deliverPictures({ result, windows }: PreparedPictures) {
    for (const w of windows) {
      if (!w.jpeg || !w.timestamps.length) continue;
      if (w.clock === "timeline" && caps.images) readPassage(w.id, w.range);
      const key = JSON.stringify([w.clock, w.id, w.range]);
      if (taskId && scanScopes.size && !reviewPassages.has(key)) {
        reviewPassages.add(key);
        const n = reviewPassages.size;
        if (n === 1 || n % 10 === 0) await postEvent({ type: "log", data: { kind: "editor_progress", reviewCounter: "pictures", count: n },
          text: n === 1 ? "The first passage is ready for picture review." : `Prepared frames for ${n} passages in the edit.` });
      }
    }
    return result;
  }

  tool("frame_contact_sheet",
    "See timestamped frames from one source or timeline window of up to 120 s. Use activity mode (up to 12 s) for pause checks, scene mode for shots, or focus for a cut boundary. For two or more windows use frame_contact_sheet_batch, which returns all of them in one result.",
    { ...SheetOptions, mediaId: z.string().optional(), version: z.string().optional() },
    async args => {
      const [request] = await pinPictures([SheetRequest.parse(args)]);
      return deliverPictures(await preparePictures(request!));
    });

  // One call waits for the whole batch, a margin under the harness's tool deadline (toolWaitSeconds): 25 s for a
  // client Scarlet didn't launch, as before.
  const batches = new PictureBatches(preparePictures, { waitMs: toolWait(caps, 20) * 1000 });
  tool("frame_contact_sheet_batch",
    "Inspect 1–8 independent picture windows together, each up to 120 s. One call returns every window's sheet, labeled by the index of its original window. If any took longer, nextCursor is set: collect the rest with batchId and that cursor until null. Activity sheets check every frame for pause decisions.",
    { windows: z.array(SheetRequest).min(1).max(8).optional(), batchId: z.string().min(1).optional(), cursor: z.number().int().nonnegative().default(0) },
    async ({ windows, batchId, cursor }) => {
      if (!!windows === !!batchId || (windows && cursor)) throw new Error("Submit windows or collect a batchId with its cursor.");
      const id = batchId ?? batches.start(await pinPictures(windows!));
      const page = await batches.collect(id, cursor);
      const content: ToolResult["content"] = [{ type: "text", text: JSON.stringify({ batchId: id, total: page.total, nextCursor: page.nextCursor }) }];
      for (const item of page.items) {
        content.push({ type: "text", text: JSON.stringify({ index: item.index, ...("error" in item && { error: item.error }) }) });
        if ("pictures" in item) content.push(...(await deliverPictures(item.pictures)).content);
      }
      return { content };
    });

  /**
   * A passage of a recording for the model to hear: the audio itself, or the WAV file written to the task folder and
   * where it is. One call's files keep apart by the passage's place, so a second listen to it reads the same file.
   */
  async function heard(mediaId: string, from: number, to: number, voice: z.infer<typeof SourceAudioOptions.voice>): Promise<ToolResult["content"]> {
    const { wav } = await client.sourceAudio(projectId, { mediaId, from, to, ...(voice && { voice }) });
    if (listen?.by !== "file") return [{ type: "audio", mimeType: "audio/wav", data: wav }];
    const name = `listen/${mediaId}-${from.toFixed(2)}-${to.toFixed(2)}${voice ? `-${voice.replace(/\W+/g, "-")}` : ""}.wav`;
    const file = await writeArtifact!(name, Buffer.from(wav, "base64"));
    return [{ type: "text", text: JSON.stringify({ listen: file, mediaId, from, to, seconds: +(to - from).toFixed(2),
      how: "Open this WAV file with your own file viewer to hear the passage. Its start is the recording's second `from`." }) }];
  }

  // Offered only to a model that can hear (see agentCapabilities).
  tool("source_audio",
    `Listen to up to ${listen?.most ?? SOURCE_AUDIO_IN_RESULT} seconds of an original microphone or video, in source seconds: hear where a restart's abandoned attempt starts and ends, compare takes, or hear an edge before deciding a cut.` +
      (listen?.by === "file" ? " Scarlet writes the passage as a WAV file to your task folder and says where: open it with your own file viewer to hear it." : ""),
    SourceAudioOptions, async ({ mediaId, from, to, voice }) => {
      const most = listen?.most ?? SOURCE_AUDIO_IN_RESULT;
      if (to - from > most + 1e-6) return text(`Choose a passage of up to ${most} s: ${mediaId} ${from}–${to} is ${(to - from).toFixed(2)} s.`);
      return { content: await heard(mediaId, from, to, voice) };
    });

  // A request whose model can't hear has another model listen for it, when one that can is signed in.
  const listenerName = listener && (listener.agent === "gemini" ? "Gemini" : listener.model ?? listener.agent);
  if (!listen && listener && taskId && task && isProjectEditTask(task)) tool("listen",
    `Have ${listenerName}, a model that can hear, listen to up to ${SOURCE_AUDIO_MOST} seconds of an original microphone or video for you, in source seconds, and answer your question about it in words. You can't hear, and a transcript misses what an editor hears: a false start that reads as a finished line, a word cut off or slurred, a repeated word the transcript tidied away, a hum or a click. Ask what you need to decide, such as where a restart's abandoned attempt ends and the kept line begins, or whether a word sounds whole; for a restart, give it the stretch from before the first try to the line said through, since the join alone sounds fine. It answers from the sound, with times in source seconds, and says what it is unsure of. A listen takes a minute or so, and several can run at once; asked again with the same passage and question, it returns the answer already given.`,
    { ...SourceAudioOptions, question: z.string().trim().min(1).max(2000).describe("What to listen for, in plain words") },
    async ({ mediaId, from, to, voice, question }) => {
      if (to - from > SOURCE_AUDIO_MOST + 1e-6) return text(`Choose a passage of up to ${SOURCE_AUDIO_MOST} s: ${mediaId} ${from}–${to} is ${(to - from).toFixed(2)} s.`);
      const heard = await client.listen(projectId, { taskId, mediaId, from, to, ...(voice && { voice }), question }, waitLeft(10));
      const by = heard.state === "unavailable" ? undefined : heard.by.agent === "gemini" ? "Gemini" : heard.by.model ?? heard.by.agent;
      if (heard.state === "heard") return json({ mediaId, from, to, heardBy: by, heard: heard.answer });
      if (heard.state === "listening") return text(`${by} is still listening to ${mediaId} ${from}–${to} s. Call listen again with the same passage and question for its answer.`);
      if (heard.state === "failed") return text(`${by} couldn't listen to ${mediaId} ${from}–${to} s: ${heard.error}`);
      return text(`No model that can hear is available now: ${heard.reason}`);
    });

  /** One recording's sound picture over a passage: its layout, the picture, and the audio for a model that can hear. */
  async function soundPicture(mediaId: string, from: number, to: number, remove: Array<{ start: number; end: number }> | undefined, voice: z.infer<typeof SourceAudioOptions.voice>): Promise<ToolResult["content"]> {
    const words = (await transcriptWords(mediaId).catch(withoutOnce(`failed to read the words of ${mediaId} for a sound picture`, null)))
      ?.filter(w => w.end > from && w.start < to && w.text.trim()).map(w => ({ text: w.text.trim(), start: w.start, end: w.end }));
    const { jpeg, layout } = await client.soundPicture(projectId, { mediaId, from, to, ...(remove && { remove }), ...(voice && { voice }), ...(words && { words }) });
    const content: ToolResult["content"] = [{ type: "text", text: JSON.stringify({ mediaId, from, to, ...layout }) }, { type: "image", mimeType: "image/jpeg", data: jpeg }];
    // A model that can hear gets the passage itself with the picture, without asking twice.
    if (listen && to - from <= listen.most) {
      const passage = await heard(mediaId, from, to, voice).catch(withoutOnce(`failed to read the audio of ${mediaId} for a sound picture`, null));
      if (passage) content.push(...passage);
    }
    return content;
  }

  tool("sound_picture",
    `Look at up to 15 s of a recording the way an editor does: its waveform over its spectrogram (0 to 8 kHz bottom to top, brighter is louder), with the transcript's words at their times and a tick where each starts. It shows what words and level figures cannot: a word cut short, the hiss of an “s”, a breath, a click, speech the transcript left out. With \`remove\`, those source ranges are shaded and a second row shows the passage as it would play with them out, at the same scale, each join a red line: look at a join before you make it. The text beside the picture gives each row's place in it and the pixels per second.${listen ? listen.by === "file" ? " Scarlet also writes the passage as a WAV file to your task folder, to open with your own file viewer and hear." : ` A passage of up to ${listen.most} seconds also comes as audio.` : ""} To see the same passage on several recordings, such as two microphones, list up to four as mediaIds instead of mediaId: each comes back in that order, its text first, and one that couldn't be drawn has an \`error\` (or \`preparing\`) in its place.`,
    { ...SoundPictureOptions, mediaId: SoundPictureOptions.mediaId.optional(),
      mediaIds: RecordingList.max(4).optional().describe("Several recordings to draw over the same passage in one call, instead of mediaId") },
    async ({ mediaId, mediaIds, from, to, remove, voice }) => {
      const several = recordingsAsked(mediaId, mediaIds);
      if (!several) return { content: await soundPicture(mediaId!, from, to, remove, voice) };
      const drawn = await eachRecording(several, id => soundPicture(id, from, to, remove, voice));
      return { content: drawn.flatMap(d => "read" in d ? d.read : [{ type: "text" as const, text: JSON.stringify(d) }]) };
    });

  const { includeAudio: _reviewAudio, ...cutReviewShape } = CutReviewOptions;
  tool("change_review_cut",
    "Compare one chronological cut or changed spot on the original and proposed versions. Reports new black frames, freezes and abrupt mix-level changes (dB)." + (caps.images ? " Includes labeled composite frames." : "") + " Read total to review the next index. For how a dialogue join sounds, use timeline_join_audit.",
    { ...cutReviewShape, ...audioOption(listen?.by === "file" ? "Write a short WAV file of each side to your task folder to open with your file viewer and hear" : "Attach a short WAV of each side") },
    args => inspect(() => client.reviewCut(projectId, { ...args, includeAudio: !!listen && (args.includeAudio ?? defaultAudio) })));

  // Only the run that looks at one frame gives an area. A pass given the same power answered for a whole recording at
  // once, from scripts and small frames: 230 areas in ten calls, one inside the editor's box of eleven (2026-11-16).
  const givesAreas = !taskId || task?.kind === "area_check";
  tool(
    "screen_area",
    "What of a recording's picture viewers may see. A screen recording usually holds more than the window being presented: the desktop, a taskbar, a recording app, a call beside it. An area is a box given on the frame at a SOURCE second, as [left, top, right, bottom] in percent of the picture: everything outside it stays out of the video. Scarlet finds the straight edges under the box on that frame and holds the area for every stretch of the recording where those edges are still in place, so one area serves a window for as long as it stays where it is, and comes back when the window does. A box with only one edge inside the picture, such as the whole screen but its menu bar, holds for as long as that line is there and the picture doesn't change at once, as it does at a switch to another app. The result lists each area with the source seconds it holds for (`holds`) and any side with no line under it on its frame (`noLine`: that side is not needed for the area to hold), and `unset`: the stretches no area holds for, with the seconds of each the current edit plays (`onPicture`) and a second to look at (`look`)." +
      (givesAreas
        ? " `set` gives an area for the frame at `at`; one given again at the same second replaces the one there, and `remove` takes areas out by their `at`. A side given within a percent of a line in the picture is put on that line. The whole picture, [0, 0, 100, 100], is an area like any other, for a recording where all of it may show."
        : " Areas come from a look at one full-size frame at a time, which Scarlet starts itself: where an edit frames part of a picture that has no area yet, it has that frame looked at before it checks the save, so a save can take longer the first time a recording is framed. `ask` has the frames at those source seconds looked at now, for a stretch you are about to frame or an area that is wrong for its footage (a frame is given to the area looked at nearest to it in time); it waits for the answers. A recording whose area is the whole picture, as a camera's is, needs no ask: all of it may show.") +
      (caps.images && givesAreas ? " With the result come pictures of the first few unset stretches the edit plays, at `look`, with percent lines drawn over them. `pictures` sets how many (default 4, 0 for none)." : "") +
      " Every save is checked against these: an edit that frames footage past its area is not saved, and its refusal names each place. timeline_framing keeps its frames inside the area on record when no `within` is given. A recording is read once for its edges; until that is done the result says so and `holds` are empty: call again.",
    {
      mediaId: z.string().describe("Media asset id"),
      ...(givesAreas ? {
        set: z.array(z.object({ at: z.number().min(0).describe("Source second of the frame the area was read on"), area: percentBox })).max(60).optional(),
        remove: z.array(z.number().min(0)).max(60).optional().describe("The `at` of each area to take out"),
        ...(caps.images && { pictures: z.number().int().min(0).max(6).optional() }),
      } : {
        ask: z.array(z.number().min(0)).max(12).optional().describe("Source seconds of frames to have looked at"),
      }),
    },
    async ({ mediaId, ...rest }) => {
      const { set, remove, ask } = rest as { set?: Array<{ at: number; area: number[] }>; remove?: number[]; ask?: number[] };
      const pictures = caps.images && givesAreas ? (rest as { pictures?: number }).pictures ?? 4 : 0;
      const { project } = await getProject();
      const asset = requireMediaAsset(project, mediaId);
      if (asset.kind !== "video") throw new Error(`Media ${mediaId} is ${asset.kind}: only a video has a picture to show.`);
      const bad = (set ?? []).flatMap((a, i) => a.area[2]! - a.area[0]! >= 5 && a.area[3]! - a.area[1]! >= 5 ? [] : [`set[${i}].area`]);
      if (bad.length) throw new Error(`${bad.length > 1 ? `${bad.slice(0, -1).join(", ")} and ${bad.at(-1)} are each` : `${bad[0]} is`} [left, top, right, bottom] in percent, at least 5 percent each way.`);
      const wait = waitLeft(20);
      const path = `/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}/show-area?wait=${wait}`;
      const state = set?.length || remove?.length
        ? await client.post<RecordingAreas & { error?: string }>(path, { set: set?.map(a => ({ at: a.at, area: a.area.map(n => n / 100) })), remove })
        : ask?.length && taskId
        ? await client.post<RecordingAreas & { error?: string; asked: number; waiting: number }>(path.replace("/show-area?", "/show-area/ask?"), { seconds: ask, taskId, again: true })
        : await client.get<RecordingAreas & { error?: string }>(path);
      const stillLooking = (state as { waiting?: number }).waiting;
      const r1 = (n: number) => Math.round(n * 10) / 10;
      const areas = state.areas.map(a => ({ at: a.at, area: a.area.map(pct1), holds: a.holds.map(([from, to]) => [r1(from), r1(to)]),
        heldSeconds: Math.round(a.holds.reduce((n, [from, to]) => n + to - from, 0)), ...(a.noLine.length && { noLine: a.noLine }) }));
      if (!state.done) {
        return json({ mediaId, reading: state.error ? `The recording's edges could not be read: ${state.error}` : "The recording's edges are still being read: call again for where each area holds and what is unset.", areas });
      }
      // What the edit as it stands plays of each unset stretch: those are the ones a save will ask about.
      const timeline = await baseTimeline().catch(() => null);
      const plays = (timeline?.tracks ?? []).filter(t => t.kind === "video" && !t.hidden).flatMap(t => t.clips)
        .filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false && c.mediaId === mediaId);
      const unset = state.unset.map(([from, to]) => {
        const parts = plays.map(c => [Math.max(from, c.sourceIn), Math.min(to, c.sourceOut), c.speed ?? 1] as const).filter(([a, b]) => b > a);
        const onPicture = parts.reduce((n, [a, b, speed]) => n + (b - a) / speed, 0);
        const first = parts.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]))[0];
        return { from: r1(from), to: r1(to), onPicture: r1(onPicture), look: r1(first ? (first[0] + first[1]) / 2 : (from + to) / 2) };
      });
      const shown = [...unset].sort((a, b) => b.onPicture - a.onPicture || (b.to - b.from) - (a.to - a.from)).slice(0, pictures);
      const images = await Promise.all(shown.map(async u => {
        try {
          return { look: u.look, ...await sourceFrame(mediaId, u.look, 1280, undefined, true) };
        } catch { return undefined; }
      }));
      const seen = images.filter((i): i is NonNullable<typeof i> => !!i);
      const body = { mediaId, ...(stillLooking && { stillLooking: `${stillLooking} frame${stillLooking === 1 ? " is" : "s are"} still being looked at: call again for their areas` }), areas, unset: unset.slice(0, 60), ...(unset.length > 60 && { moreUnset: unset.length - 60 }),
        ...(seen.length && { pictures: seen.map(i => `source ${i.look} s`) }) };
      if (!seen.length) return json(body);
      return { content: [{ type: "text" as const, text: JSON.stringify(body) }, ...seen.map(i => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))] };
    },
  );

  tool(
    "media_frame",
    "Look at a single video frame: the one on screen at `t`, which started at or before it. `t` is seconds into the SOURCE media (not the timeline; use timeline_at to map a timeline time to a source time). `width` is the picture's width in pixels: 640 by default, which shows what is in the frame; a screen recording's panes, controls and text take 1280 to 1920 to make out. `area` looks closer at one part of the picture, drawn `width` wide. `grid` draws lines at round percents of the source picture, each labelled at the top and left edges, so an area can be named as [left, top, right, bottom] in percent: the units of screen_text's boxes and of timeline_framing.",
    {
      mediaId: z.string().describe("Media asset id"),
      t: z.number().min(0).describe("Source time in seconds"),
      width: z.number().int().min(64).max(1920).optional().describe("Output width in pixels, default 640"),
      area: percentBox.optional()
        .describe("Only this part of the picture: [left, top, right, bottom] in percent of it"),
      grid: z.boolean().optional().describe("Draw labelled percent lines over the picture"),
    },
    async ({ mediaId, t, width, area, grid }) => {
      const w = width ?? 640;
      if (area && !(area[2]! - area[0]! >= 1 && area[3]! - area[1]! >= 1)) throw new Error("area is [left, top, right, bottom] in percent, at least 1 percent each way.");
      const { data, mimeType } = await sourceFrame(mediaId, t, w, area, grid);
      return {
        content: [
          { type: "text", text: `Frame of ${mediaId} on screen at ${t.toFixed(3)} s (${w}px wide${area ? `, ${area[0]}–${area[2]}% across and ${area[1]}–${area[3]}% down` : ""}${grid ? ", lines in percent of the whole picture" : ""}).` },
          { type: "image", data, mimeType },
        ],
      };
    },
  );

  return {
    inspect,
    rendersDone,
    sourceFrame,
    close: () => batches.close(),
  };
}
