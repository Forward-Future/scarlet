import { ScarletApiError, type Task } from "@scarlet/shared";
import { emptyTimeline, newId, timelineDuration, type AudioTrackSelection, type MediaAsset } from "@scarlet/timeline";
import { SAMPLE_TRANSCRIPTION_MODEL } from "./fixtures";
import type { MockStore } from "./store";
import { notFound, now, sleep } from "./util";

export function uploadMedia(store: MockStore, projectId: string, file: Blob, name: string, kind?: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const guessed: MediaAsset["kind"] = /^(wav|mp3|aac|m4a|flac|ogg)$/.test(ext) ? "audio" : /^(png|jpe?g|webp|gif)$/.test(ext) ? "image" : "video";
  const mediaKind = (kind as MediaAsset["kind"] | undefined) ?? guessed;
  const media: MediaAsset = { id: newId("med"), kind: mediaKind, name, path: `media/${name}`, status: "ingesting", ...(mediaKind === "video" ? { fps: 30, width: 640, height: 360 } : {}) };
  (store.db.media[projectId] ??= []).push(media);
  const project = store.projectById(projectId);
  project.media = store.db.media[projectId] ?? [];
  store.refreshCounts(projectId);
  void simulateIngest(store, projectId, media, file.size);
  return { media };
}

/** A file imported by path or link, ingesting. */
export function addImportedMedia(store: MockStore, projectId: string, body: { path?: string; url?: string; kind?: string; importId?: string }): MediaAsset {
  const src = body.url ?? body.path ?? "import";
  const name = decodeURIComponent(src.split(/[\\/?#]/).filter(Boolean).pop() ?? "import.mp4").slice(0, 60) || "import.mp4";
  const guessed = /\.(wav|mp3|aac|m4a|flac|ogg)$/i.test(name) ? "audio" : /\.(png|jpe?g|webp|gif)$/i.test(name) ? "image" : "video";
  const kind = (body.kind as MediaAsset["kind"] | undefined) ?? guessed;
  const media: MediaAsset = { id: newId("med"), importId: body.importId, kind, name: /drive\.google/.test(src) ? `drive-${name}.mp4` : name, path: `media/${name}`, status: "ingesting", ...(kind === "video" ? { fps: 30, width: 640, height: 360 } : {}) };
  (store.db.media[projectId] ??= []).push(media);
  store.projectById(projectId).media = store.db.media[projectId] ?? [];
  store.refreshCounts(projectId);
  void simulateIngest(store, projectId, media, 50_000_000);
  return media;
}

export function removeMedia(store: MockStore, projectId: string, mediaId: string) {
  const list = store.db.media[projectId] ?? [];
  const media = list.find(m => m.id === mediaId);
  if (!media) throw notFound("Media");
  if (media.status !== "failed") throw new ScarletApiError(409, "media_readable", `Scarlet read ${media.name}, and can only remove a file it couldn’t read.`);
  if (Object.values(store.db.timelines).some(tl => tl.projectId === projectId && JSON.stringify(tl).includes(JSON.stringify(mediaId)))) {
    throw new ScarletApiError(409, "media_in_use", `${media.name} is in the video or its history, so it can’t be removed.`);
  }
  if (store.db.tasks.some(t => t.projectId === projectId && t.kind !== "transcribe" && ["claimed", "running", "waiting_for_user"].includes(t.state))) {
    throw new ScarletApiError(409, "media_busy", `Scarlet is working on a request, so ${media.name} can’t be removed until it’s done.`);
  }
  store.db.media[projectId] = list.filter(m => m.id !== mediaId);
  store.projectById(projectId).media = store.db.media[projectId]!;
  store.refreshCounts(projectId);
  store.log(projectId, "media.removed", `${store.currentUser().name} removed “${media.name}”, which couldn't be read`, { mediaId });
  store.emit({ type: "media.removed", projectId, mediaId });
  return {};
}

/** Choose which audio track of a multi-track recording Scarlet reads. */
export function setMediaAudioTrack(store: MockStore, mediaId: string, audioTrack: AudioTrackSelection) {
  for (const [projectId, list] of Object.entries(store.db.media)) {
    const current = list.find(m => m.id === mediaId);
    if (!current) continue;
    const count = current.audioStreams?.length ?? 1;
    if (typeof audioTrack === "number" && audioTrack >= count) {
      throw new ScarletApiError(400, "bad_audio_track", `This file only has ${count} audio ${count === 1 ? "track" : "tracks"}.`);
    }
    const updated: MediaAsset = { ...current, audioTrack: audioTrack === 0 ? undefined : audioTrack };
    replaceMedia(store, projectId, updated);
    store.emit({ type: "media.updated", projectId, media: updated });
    return { media: updated };
  }
  throw notFound("Media");
}

export function transcribe(store: MockStore, mediaId: string, provider?: string) {
  const projectId = Object.entries(store.db.media).find(([, list]) => list.some((m) => m.id === mediaId))?.[0];
  if (!projectId) throw notFound("Media");
  store.requireTranscription();
  const task: Task = { id: newId("task"), projectId, kind: "transcribe", agent: "api", model: provider, instruction: `Transcribe ${mediaId}`, context: { mediaId }, state: "running", createdBy: store.human(), hostId: null, changeIds: [], question: null, summary: null, createdAt: now(), startedAt: now() };
  store.db.tasks.unshift(task);
  void (async () => {
    await sleep(3000);
    const media = store.db.media[projectId]?.find((m) => m.id === mediaId);
    const completedAt = now();
    if (media) saveSampleTranscript(store, projectId, media, newId("trs"), completedAt);
    task.state = "done";
    task.finishedAt = completedAt;
    task.summary = `Transcribed 20 s of speech (${SAMPLE_TRANSCRIPTION_MODEL}).`;
    store.emit({ type: "task.updated", projectId, task: { ...task } });
  })();
  return { task };
}

async function simulateIngest(store: MockStore, projectId: string, media: MediaAsset, bytes: number) {
  await sleep(1800);
  const probed: MediaAsset = {
    ...media,
    status: "ready",
    hash: newId(undefined, 8),
    duration: media.kind === "image" ? undefined : 20,
    fps: media.kind === "video" ? 30 : undefined,
    width: media.kind === "audio" ? undefined : 640,
    height: media.kind === "audio" ? undefined : 360,
    hasAudio: media.kind !== "image",
  };
  replaceMedia(store, projectId, probed);
  store.emit({ type: "media.updated", projectId, media: probed });
  const project = store.projectById(projectId);
  if (!project.head && (probed.kind === "video" || probed.kind === "audio")) {
    const tl = emptyTimeline(projectId);
    tl.version = newId("ver");
    tl.createdAt = now();
    store.db.timelines[tl.version] = tl;
    project.head = tl.version;
    store.summary(projectId).head = tl.version;
    (store.db.versions[projectId] ??= []).push({ version: tl.version, parent: null, name: "Main", author: { type: "scarlet", name: "Scarlet" }, changeId: null, description: `Imported ${probed.name}`, duration: timelineDuration(tl), isHead: true, createdAt: tl.createdAt });
    store.emitProject(projectId);
  }
  if (store.db.settings.transcription.provider !== "none" && probed.hasAudio && bytes > 0) {
    await sleep(2200);
    saveSampleTranscript(store, projectId, probed, `tr_${probed.id}`, now());
  }
}

function saveSampleTranscript(store: MockStore, projectId: string, media: MediaAsset, id: string, completedAt: string) {
  const sample = store.db.transcripts[media.id] ?? store.db.transcripts.med_main!;
  store.db.transcripts[media.id] = { ...sample, id, mediaId: media.id, createdAt: completedAt };
  const updated = { ...media, transcriptId: id, lastTranscription: { completedAt, model: SAMPLE_TRANSCRIPTION_MODEL } };
  replaceMedia(store, projectId, updated);
  store.emit({ type: "media.updated", projectId, media: updated });
}

function replaceMedia(store: MockStore, projectId: string, media: MediaAsset) {
  const list = store.db.media[projectId] ?? [];
  const i = list.findIndex((m) => m.id === media.id);
  if (i >= 0) list[i] = media;
  else list.push(media);
  store.projectById(projectId).media = list;
}
