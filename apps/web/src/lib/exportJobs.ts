import { fullRenderContext, ScarletApiError, type Render, type RenderRequest } from "@scarlet/shared";
import { create } from "zustand";
import { api, errorMessage } from "./client";
import { appLog, withoutAddresses } from "./appLog";
import { desktop } from "./desktop";
import { renderCompletion } from "./renderCompletion";
import { useProjectStore, type ProjectData } from "../stores/project";
import { useUiStore } from "../stores/ui";

export interface ExportJob {
  file: ExportFile;
  context: string;
  version: string;
  projectSettings?: Render["projectSettings"];
  phase: "choosing" | "rendering" | "saving";
  progress: number;
  /** The engine hasn't started the render: it was just asked for, or it waits behind others. There is no progress to show. */
  waiting?: boolean;
  cancel(): void;
}

/** The percent the render's count stops at. It follows the picture only: the audio mix and the final join report nothing. */
export const PICTURE_DONE = 97;

/**
 * Whether an export's percent is moving. It isn't for a render that hasn't started, and not once the picture is done,
 * where the count stops through the audio mix and the final join. It is compared as it reads, so that figure never shows.
 */
export function exportCounting(job: ExportJob): boolean {
  const percent = Math.round(job.progress * 100);
  return job.phase === "rendering" && !job.waiting && percent > 0 && percent < PICTURE_DONE;
}

/** How the last export ended. `context` is the video it was for: a saved file is the video's export only until the video changes. */
export type ExportResult = { phase: "done"; path: string; context: string }
  /** `seen`: the editor has had the reason in front of them, in the Export sheet. Until then the menu is marked for it. */
  | { phase: "failed"; error: string; file: ExportFile; context: string; seen?: boolean };
export type ExportState = ExportJob | ExportResult;

// Keep a requested export alive if the editor opens a different project during the render.
export const useExports = create<{ jobs: Record<string, ExportState | undefined> }>(() => ({ jobs: {} }));

/** The Export sheet is showing why a project's export stopped. */
export function exportFailureSeen(projectId: string) {
  useExports.setState(s => {
    const job = s.jobs[projectId];
    return job?.phase === "failed" && !job.seen ? { jobs: { ...s.jobs, [projectId]: { ...job, seen: true } } } : s;
  });
}

export interface ExportFile {
  /** The name the native Save dialog opens on. Once the editor has picked a file there, that file's name. */
  name: string;
  format: "mp4" | "otio";
  video: Pick<RenderRequest, "kind" | "quality" | "range" | "exportOptions">;
}

/** The engine was unreachable, as it is while Scarlet quits or restarts its engine. */
const unreachable = (err: unknown) => !(err instanceof ScarletApiError) || err.status === 503;

export function exportFile(project: ProjectData, file: ExportFile) {
  const version = project.project.head;
  if (!version) return Promise.resolve();
  return run(project.id, file, fullRenderContext(project.project), version, project);
}

/**
 * Pick up the exports the engine still owes the editor: ones that were rendering or saving when
 * Scarlet quit or the window reloaded. The engine has requeued their renders under the same ids.
 */
export async function resumeExports() {
  const { renders } = await api.exports();
  for (const render of renders) {
    const kept = render.export;
    if (!kept || useExports.getState().jobs[render.projectId]) continue;
    const video: ExportFile["video"] = { kind: render.kind, quality: render.quality ?? "delivery" };
    if (render.range) video.range = render.range;
    if (render.exportOptions) video.exportOptions = render.exportOptions;
    const context = fullRenderContext({ id: render.projectId, head: render.version, settings: render.projectSettings! });
    void run(render.projectId, { name: kept.name, format: "mp4", video }, context, render.version, undefined, render);
  }
}

async function run(projectId: string, file: ExportFile, context: string, version: string, project?: ProjectData, resumed?: Render) {
  const prior = useExports.getState().jobs[projectId];
  if (prior && "cancel" in prior) return;
  let result: ExportResult | undefined;
  let ticket: number | null = resumed?.export?.ticket ?? null;
  const wait = new AbortController();
  let cancelled = false;
  const owner = resumed?.export?.owner ?? crypto.randomUUID();
  let ownedId = resumed?.id;
  let job: ExportJob = { file, context, version, projectSettings: resumed?.projectSettings ?? project?.project.settings,
    phase: resumed ? "rendering" : "choosing", progress: resumed?.progress ?? 0, cancel };

  function update(change: Partial<ExportJob>) {
    job = { ...job, ...change };
    useExports.setState(s => ({ jobs: { ...s.jobs, [projectId]: job } }));
  }
  function finish(outcome?: ExportResult) {
    useExports.setState(s => {
      if (s.jobs[projectId] !== job) return s;
      if (outcome) return { jobs: { ...s.jobs, [projectId]: outcome } };
      const jobs = { ...s.jobs };
      delete jobs[projectId];
      return { jobs };
    });
  }
  async function discard() {
    const chosen = ticket;
    ticket = null;
    if (chosen !== null) await desktop.discardVideoExport(chosen).catch(() => undefined);
  }
  function cancel() {
    cancelled = true;
    wait.abort();
    if (ownedId) void api.releaseRender(ownedId, owner).catch(() => {});
    finish();
    void discard();
  }
  update({});
  let path = resumed?.export?.path;
  try {
    if (!resumed) {
      // The native Save dialog asks for the file's name and its folder. The ticket is the app's permission to write it.
      const choice = await desktop.chooseVideoExport(file.name);
      if (!choice) return;
      ticket = choice.ticket;
      path = choice.path;
      file = { ...file, name: path.split(/[\\/]/).pop() || file.name };
      update({ file });
      // The native chooser can be open during a restore or a format change.
      const active = useProjectStore.getState().current;
      if (!project || !active || fullRenderContext(active.project) !== fullRenderContext(project.project)) {
        throw new Error("The video changed. Export again to use the latest version.");
      }
    }
    if (ticket === null) throw new Error("Export destination expired");
    let url: string;
    if (file.format === "otio") {
      url = api.otioUrl(projectId, version);
    } else {
      update({ phase: "rendering", waiting: true });
      let render = resumed;
      if (!render) {
        // The engine and the app both record the export, so it finishes after a restart.
        await desktop.keepVideoExport(ticket);
        if (cancelled) return;
        render = (await api.requestRender(projectId, { ...file.video, version, owner, export: { name: file.name, ticket, path } })).render;
      }
      const id = ownedId = render.id;
      if (cancelled) { await api.releaseRender(id, owner); return; }
      for (;;) {
        if (cancelled) return;
        if (!resumed && project && (render.id !== id || render.projectId !== projectId || render.version !== version || render.kind !== file.video.kind ||
            render.quality !== file.video.quality ||
            (render.projectSettings && fullRenderContext({ ...project.project, settings: render.projectSettings }) !== job.context) ||
            render.range?.start !== file.video.range?.start || render.range?.end !== file.video.range?.end ||
            render.exportOptions?.height !== file.video.exportOptions?.height || !!render.exportOptions?.omitCaptions !== !!file.video.exportOptions?.omitCaptions)) {
          throw new Error("The export no longer matches the video.");
        }
        if (render.state === "done") break;
        if (render.state === "failed" || render.state === "cancelled") throw new Error(render.error || "The render stopped.");
        update({ progress: render.progress, waiting: render.state === "queued" });
        const completed = await renderCompletion(projectId, id, 750, wait.signal);
        if (cancelled) return;
        // Keep waiting while the engine restarts. It resumes this render under the same id.
        render = completed ?? await api.render(id).then(found => found.render, err => { if (unreachable(err)) return render!; throw err; });
      }
      url = api.renderFileUrl(id);
    }
    update({ phase: "saving" });
    const saved = await desktop.finishVideoExport(ticket, url);
    ticket = null;
    result = { phase: "done", path: saved, context: job.context };
  } catch (err) {
    // A resumed export whose destination is gone was already saved or discarded before the restart.
    const settled = resumed && errorMessage(err) === "Export destination expired";
    if (!cancelled && !settled) {
      result = { phase: "failed", error: errorMessage(err), file, context: job.context };
      // Where it stopped and why. Never the file's name or where it was going (the editor typed those), nor the
      // folder, which a failure can name by another file in it, nor the address the file was read from.
      const cut = path ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) : -1;
      let error = result.error;
      for (const own of [path, cut > 0 ? path!.slice(0, cut) : "", path?.slice(cut + 1), file.name]) if (own) error = error.split(own).join("…");
      error = withoutAddresses(error);
      if (error.length > 300) error = `${error.slice(0, 299)}…`;
      appLog("error", "export", { phase: job.phase, format: file.format, resumed: resumed ? true : undefined, error }, { level: "warn" });
    }
  } finally {
    finish(result);
    if (result?.phase === "done" && file.format === "mp4") useUiStore.getState().offerExportStar();
    if (resumed && result) {
      useUiStore.getState().notify(result.phase === "done"
        ? { title: "Export finished", body: file.name, projectId }
        : { title: "Export didn’t finish", body: `${file.name}: ${result.error}`, projectId });
    }
    // Tell the engine the export is settled. If it can't hear, leave the destination for the next launch to finish.
    const released = !ownedId || cancelled || await api.releaseRender(ownedId, owner).then(() => true, () => false);
    if (released) await discard();
  }
}
