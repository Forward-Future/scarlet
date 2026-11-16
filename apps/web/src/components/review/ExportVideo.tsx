import { useEffect, useMemo, useState } from "react";
import { fullRenderContext, type RenderRequest } from "@scarlet/shared";
import { captionTracks, handoffLosses, snapToFrame, timelineDuration, usedMedia } from "@scarlet/timeline";
import { errorMessage, IS_MOCK } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { exportCounting, exportFailureSeen, exportFile, PICTURE_DONE, useExports, type ExportFile } from "../../lib/exportJobs";
import { clock, fmtBytes, pct, playbackClock } from "../../lib/format";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { ActivityProgress, Field, Icon, InlineError, Modal } from "../ui/primitives";
import { PreferenceSelect } from "../ui/PreferenceSelect";

type ExportQuality = RenderRequest["quality"] | "best";

/** The export's quality levels, smallest first. Original quality encodes in software; High uses the computer's video encoder. */
const QUALITY: Record<ExportQuality, { label: string; hint: string }> = {
  preview: { label: "Compressed", hint: "A smaller file for sharing a draft. Softer picture." },
  delivery: { label: "High", hint: "Looks the same as the original, in a smaller file." },
  best: { label: "Original quality", hint: "Matches the original footage, for re-editing or grading. About the size of the original." },
};

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
  // Advanced export: the folder for finishing the edit in another app. Otherwise the video.
  const [advanced, setAdvanced] = useState(previous?.format === "folder");
  const format: ExportFile["format"] = advanced ? "folder" : "mp4";
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
  const [quality, setQuality] = useState<ExportQuality>(previous?.video.exportOptions?.bestQuality ? "best" : previous?.video.quality ?? "delivery");
  const [revealError, setRevealError] = useState("");
  // A percent shows only while it moves.
  const counting = !!busy && exportCounting(busy);
  // An export that stopped is explained here, so the menu's mark for it goes once this is open.
  const failed = job?.phase === "failed";
  useEffect(() => { if (failed) exportFailureSeen(current.id); }, [failed, current.id]);
  const range = format === "mp4" && customRange ? { start: snapToFrame(parseClock(start), fps), end: snapToFrame(parseClock(end), fps) } : undefined;
  const invalidRange = range && !(range.start >= 0 && range.end > range.start && range.end <= duration);
  const custom = format === "mp4" && (!!range || !!targetHeight || quality !== "delivery");
  const level = QUALITY[quality];
  const sampleOnly = IS_MOCK && custom;
  const handoff = useMemo(() => {
    if (!current.timeline) return undefined;
    const used = usedMedia(project, current.timeline);
    const sizes = used.map(m => m.fingerprintStamp?.size);
    return {
      bytes: sizes.every(size => size !== undefined) ? sizes.reduce((a, b) => a + b!, 0) : undefined,
      files: used.length,
      captions: captionTracks(current.timeline).length > 0,
      losses: handoffLosses(project, current.timeline),
    };
  }, [project, current.timeline]);
  const invalid = !hasCut || !duration || invalidRange || sampleOnly;
  const size = targetHeight ? `${Math.round(width * targetHeight / height / 2) * 2} × ${targetHeight}` : "Project size";
  const submit = () => {
    if (busy || invalid) return;
    const video: ExportFile["video"] = { kind: custom ? "export" : "full", quality: quality === "best" ? "delivery" : quality };
    if (range) video.range = range;
    if (targetHeight || quality === "best") {
      video.exportOptions = { ...(targetHeight ? { height: targetHeight } : {}), ...(quality === "best" ? { bestQuality: true } : {}) };
    }
    setRevealError("");
    // The file is named once, in the system's Save dialog, which also picks its folder and asks before replacing a
    // file. It opens on the project's name.
    const stem = project.name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Scarlet";
    const name = format === "folder" ? stem : `${stem}.${format}`;
    void exportFile(current, { format, name, video });
  };
  const switchTo = !busy && !exported && <button type="button" className="btn-quiet mr-auto" onClick={() => setAdvanced(!advanced)}>
    {advanced ? "Back" : "Advanced export"}
  </button>;
  return <Modal open title={advanced ? "Advanced export" : "Export"} width={600} onClose={onClose} footer={running ? <>
    {busy.phase === "rendering" && <button type="button" className="btn-quiet" onClick={busy.cancel}>Cancel export</button>}
    <button type="button" className="btn-primary" onClick={onClose}>Continue editing</button>
  </> : <>
    {switchTo}
    <button type="button" className="btn-ghost" onClick={onClose}>{busy || exported ? "Close" : "Cancel"}</button>
    <button type="submit" form="export-working-cut" className="btn-primary" disabled={!!busy || !!invalid}>
      {failed ? "Retry" : "Export"}
    </button>
  </>}>
    <form id="export-working-cut" onSubmit={event => { event.preventDefault(); submit(); }}>
      <fieldset disabled={!!busy} className="min-w-0">
        {advanced ? <HandoffSummary summary={handoff} /> : <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
          <Field label="Range" htmlFor="export-range">
            <PreferenceSelect id="export-range" value={customRange ? "custom" : "whole"}
              onChange={value => setCustomRange(value === "custom")} options={[{ value: "whole", label: "Whole video" }, { value: "custom", label: "Custom range" }]} />
          </Field>
          {range && <div className="hidden sm:block" />}
          {range && <>
            <Field label="From" htmlFor="export-start"><input className="field tnum" id="export-start" value={start} onChange={e => setStart(e.target.value)} /></Field>
            <Field label="To" htmlFor="export-end"><input className="field tnum" id="export-end" value={end} onChange={e => setEnd(e.target.value)} /></Field>
          </>}
        </div>}
        {format === "mp4" ? <details className="border-t border-line pt-3">
          <summary className="cursor-pointer text-xs"><strong>Video options</strong><span className="ml-2 text-muted">{size} · {Number(fps.toFixed(3))} fps · {level.label}</span></summary>
          <div className="mt-4 grid grid-cols-1 gap-x-3 sm:grid-cols-2">
            <Field label="Resolution" htmlFor="export-resolution">
              <PreferenceSelect id="export-resolution" value={targetHeight} onChange={setTargetHeight} options={[
                { value: 0, label: `Project · ${width} × ${height}` },
                ...[2160, 1080, 720, 480].filter(h => h < height).map(h => ({ value: h, label: `${Math.round(width * h / height / 2) * 2} × ${h}` })),
              ]} />
            </Field>
            <Field label="Quality" htmlFor="export-quality" hint={level.hint}>
              <PreferenceSelect id="export-quality" value={quality} onChange={setQuality}
                options={(Object.keys(QUALITY) as ExportQuality[]).map(value => ({ value, label: QUALITY[value].label }))} />
            </Field>
          </div>
        </details> : null}
      </fieldset>
    </form>
    {!running && <InlineError>{!hasCut ? "There’s no video to export yet." :
      invalidRange ? `Enter a range between 0:00 and ${playbackClock(duration)}, at least one frame long.` : sampleOnly ? "The isolated demo saves its included MP4. Custom video settings are available in library projects." : ""}</InlineError>}
    {busy && <div className="mt-3">
      {busy.phase === "choosing" ? <p className="text-xs text-muted" role="status">Choose a location…</p> :
        <ActivityProgress label={`Export progress for ${busy.file.name}`} value={counting ? busy.progress : undefined}>
          {busy.phase === "saving" ? (busy.file.format === "folder" ? "Saving the folder…" : "Saving file…") : busy.waiting ? "Waiting to start" : Math.round(busy.progress * 100) >= PICTURE_DONE ? "Finishing…"
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

const SHOWN_LOSSES = 4;

/** What the folder holds and what another app won't show as Scarlet does. */
function HandoffSummary({ summary }: { summary?: { bytes?: number; files: number; captions: boolean; losses: Array<{ at?: number; what: string }> } }) {
  if (!summary) return null;
  const { losses } = summary;
  return <div className="text-xs">
    <p className="text-muted">A folder for finishing the edit in DaVinci Resolve, Final Cut Pro or Premiere Pro.</p>
    <ul className="mt-2 list-disc space-y-1 pl-4">
      <li>The timeline: cuts, tracks, zooms, volume, fades, markers and graphics</li>
      <li>A copy of the footage{summary.files ? <span className="text-muted"> · {summary.files} {summary.files === 1 ? "file" : "files"}{summary.bytes !== undefined ? `, ${fmtBytes(summary.bytes)}` : ""}</span> : null}</li>
      {summary.captions && <li>The captions, as a SubRip file</li>}
      <li>A Read me with how to open it in each app</li>
    </ul>
    {losses.length > 0 && <>
      <p className="mt-3 text-muted">Doesn’t carry over</p>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {losses.slice(0, SHOWN_LOSSES).map((loss, i) => <li key={i}>{loss.at !== undefined && <span className="tnum text-muted">{clock(loss.at)} </span>}{loss.what}</li>)}
        {losses.length > SHOWN_LOSSES && <li className="text-muted">{losses.length - SHOWN_LOSSES} more, listed in the Read me</li>}
      </ul>
    </>}
  </div>;
}
