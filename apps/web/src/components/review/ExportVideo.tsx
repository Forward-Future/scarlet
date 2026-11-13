import { useEffect, useMemo, useState } from "react";
import { fullRenderContext, type RenderRequest } from "@scarlet/shared";
import { snapToFrame, timelineDuration } from "@scarlet/timeline";
import { errorMessage, IS_MOCK } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { exportCounting, exportFailureSeen, exportFile, PICTURE_DONE, useExports, type ExportFile } from "../../lib/exportJobs";
import { pct, playbackClock } from "../../lib/format";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { ActivityProgress, Field, Icon, InlineError, Modal } from "../ui/primitives";
import { PreferenceSelect } from "../ui/PreferenceSelect";

function parseClock(value: string): number {
  if (!/^(?:\d+:)?(?:\d+:)?\d+(?:\.\d+)?$/.test(value.trim())) return NaN;
  const parts = value.trim().split(":").map(Number);
  if (parts.slice(1).some(part => part >= 60)) return NaN;
  return parts.reduce((seconds, part) => seconds * 60 + part, 0);
}

export function ExportSheet({ hasCut, onClose }: { hasCut: boolean; onClose(): void }) {
  const current = useProjectStore(s => s.current);
  return current && <ExportForm key={current.id} current={current} hasCut={hasCut} onClose={onClose} />;
}

function ExportForm({ current, hasCut, onClose }: { current: ProjectData; hasCut: boolean; onClose(): void }) {
  const { project } = current;
  const job = useExports(s => s.jobs[current.id]);
  const busy = job && "cancel" in job ? job : undefined;
  const running = busy?.phase === "rendering" || busy?.phase === "saving";
  const { width, height, fps } = busy?.projectSettings ?? project.settings;
  // The video as it is now. An edit applied while the sheet is open is the one exported: the sheet follows it.
  const context = fullRenderContext(project);
  const duration = useMemo(() => current.timeline ? snapToFrame(timelineDuration(current.timeline), fps) : 0, [current.timeline, fps]);
  const previous = busy?.file ?? (job?.phase === "failed" && job.context === context ? job.file : undefined);
  // The file the last export saved, while the video is still the one it was made from.
  const exported = job?.phase === "done" && job.context === context ? job : undefined;
  const [format, setFormat] = useState<ExportFile["format"]>(previous?.format ?? "mp4");
  const [customRange, setCustomRange] = useState(!!previous?.video.range);
  const [start, setStart] = useState(() => playbackClock(previous?.video.range?.start ?? 0));
  const [end, setEnd] = useState(() => playbackClock(previous?.video.range?.end ?? duration));
  // Until a range is picked, it would start as the whole video at the length it has now.
  useEffect(() => {
    if (customRange) return;
    setStart(playbackClock(0));
    setEnd(playbackClock(duration));
  }, [duration]); // eslint-disable-line react-hooks/exhaustive-deps
  const [targetHeight, setTargetHeight] = useState(previous?.video.exportOptions?.height ?? 0);
  const [quality, setQuality] = useState<RenderRequest["quality"]>(previous?.video.quality ?? "delivery");
  const [revealError, setRevealError] = useState("");
  // A percent shows only while it moves.
  const counting = !!busy && exportCounting(busy);
  // An export that stopped is explained here, so the menu's mark for it goes once this is open.
  const failed = job?.phase === "failed";
  useEffect(() => { if (failed) exportFailureSeen(current.id); }, [failed, current.id]);
  const range = format === "mp4" && customRange ? { start: snapToFrame(parseClock(start), fps), end: snapToFrame(parseClock(end), fps) } : undefined;
  const invalidRange = range && !(range.start >= 0 && range.end > range.start && range.end <= duration);
  const custom = format === "mp4" && (!!range || !!targetHeight || quality !== "delivery");
  const sampleOnly = IS_MOCK && custom;
  const invalid = !hasCut || !duration || invalidRange || sampleOnly;
  const size = targetHeight ? `${Math.round(width * targetHeight / height / 2) * 2} × ${targetHeight}` : "Project size";
  const submit = () => {
    if (busy || invalid) return;
    const video: ExportFile["video"] = { kind: custom ? "export" : "full", quality };
    if (range) video.range = range;
    if (targetHeight) video.exportOptions = { height: targetHeight };
    setRevealError("");
    // The file is named once, in the system's Save dialog, which also picks its folder and asks before replacing a
    // file. It opens on the project's name.
    const name = `${project.name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Scarlet"}.${format}`;
    void exportFile(current, { format, name, video });
  };
  return <Modal open title="Export" width={600} onClose={onClose} footer={running ? <>
    {busy.phase === "rendering" && <button type="button" className="btn-quiet" onClick={busy.cancel}>Cancel export</button>}
    <button type="button" className="btn-primary" onClick={onClose}>Continue editing</button>
  </> : <>
    <button type="button" className="btn-ghost" onClick={onClose}>{busy || exported ? "Close" : "Cancel"}</button>
    <button type="submit" form="export-working-cut" className="btn-primary" disabled={!!busy || !!invalid}>
      {failed ? "Retry" : "Export"}
    </button>
  </>}>
    <form id="export-working-cut" onSubmit={event => { event.preventDefault(); submit(); }}>
      <fieldset disabled={!!busy} className="min-w-0">
        <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
          <Field label="Format" htmlFor="export-format">
            <PreferenceSelect id="export-format" value={format} onChange={setFormat}
              options={[{ value: "mp4", label: "Video (.mp4)" }, { value: "otio", label: "Resolve timeline (.otio)" }]} />
          </Field>
          <Field label="Range" htmlFor="export-range">
            <PreferenceSelect id="export-range" disabled={format === "otio"} value={format === "mp4" && customRange ? "custom" : "whole"}
              onChange={value => setCustomRange(value === "custom")} options={[{ value: "whole", label: "Whole video" }, { value: "custom", label: "Custom range" }]} />
          </Field>
          {range && <>
            <Field label="From" htmlFor="export-start"><input className="field tnum" id="export-start" value={start} onChange={e => setStart(e.target.value)} /></Field>
            <Field label="To" htmlFor="export-end"><input className="field tnum" id="export-end" value={end} onChange={e => setEnd(e.target.value)} /></Field>
          </>}
        </div>
        {format === "mp4" ? <details className="border-t border-line pt-3">
          <summary className="cursor-pointer text-xs"><strong>Video options</strong><span className="ml-2 text-muted">{size} · {Number(fps.toFixed(3))} fps · {quality === "delivery" ? "Full quality" : "Smaller file"}</span></summary>
          <div className="mt-4 grid grid-cols-1 gap-x-3 sm:grid-cols-2">
            <Field label="Resolution" htmlFor="export-resolution">
              <PreferenceSelect id="export-resolution" value={targetHeight} onChange={setTargetHeight} options={[
                { value: 0, label: `Project · ${width} × ${height}` },
                ...[2160, 1080, 720, 480].filter(h => h < height).map(h => ({ value: h, label: `${Math.round(width * h / height / 2) * 2} × ${h}` })),
              ]} />
            </Field>
            <Field label="Quality" htmlFor="export-quality">
              <PreferenceSelect id="export-quality" value={quality} onChange={setQuality}
                options={[{ value: "delivery", label: "Full quality" }, { value: "preview", label: "Smaller file" }]} />
            </Field>
          </div>
        </details> : <p className="text-xs text-muted">The timeline links to the original media. The receiving editor needs access to those files.</p>}
      </fieldset>
    </form>
    {!running && <InlineError>{!hasCut ? "There’s no video to export yet." :
      invalidRange ? `Enter a range between 0:00 and ${playbackClock(duration)}, at least one frame long.` : sampleOnly ? "The isolated demo saves its included MP4. Custom video settings are available in library projects." : ""}</InlineError>}
    {busy && <div className="mt-3">
      {busy.phase === "choosing" ? <p className="text-xs text-muted" role="status">Choose a location…</p> :
        <ActivityProgress label={`Export progress for ${busy.file.name}`} value={counting ? busy.progress : undefined}>
          {busy.phase === "saving" ? "Saving file…" : busy.waiting ? "Waiting to start" : Math.round(busy.progress * 100) >= PICTURE_DONE ? "Finishing…"
            : `Exporting${busy.version !== project.head ? " an earlier version" : ""}${counting ? ` · ${pct(busy.progress)}` : ""}`}
        </ActivityProgress>}
      {running && <p className="mt-2 text-xs text-muted">Your export continues in the background while you edit.</p>}
    </div>}
    {exported && <p className="mt-3 flex items-center gap-2 text-xs" role="status"><Icon name="check" />
      <span className="truncate" title={exported.path}>{exported.path.split(/[\\/]/).pop()}</span>
      <button className="btn-quiet shrink-0" onClick={() => { setRevealError(""); void desktop.revealPath(exported.path).catch(e => setRevealError(errorMessage(e))); }}>Show in folder</button>
    </p>}
    <InlineError>{failed ? job.error : revealError}</InlineError>
  </Modal>;
}
