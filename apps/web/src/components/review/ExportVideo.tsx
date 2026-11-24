import { useEffect, useMemo, useState } from "react";
import { fullRenderContext, type RenderRequest } from "@scarlet/shared";
import { captionExportHasCues, captionTracks, handoffLosses, NO_CAPTION_TRACK, NO_CAPTIONS_IN_RANGE, snapToFrame, timelineDuration, usedMedia } from "@scarlet/timeline";
import { errorMessage, IS_MOCK } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { exportCounting, exportFailureSeen, exportFile, PICTURE_DONE, useExports, type ExportFile } from "../../lib/exportJobs";
import { clock, fileBaseName, fmtBytes, pct, playbackClock } from "../../lib/format";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { ActivityProgress, Field, Icon, InlineError, Modal } from "../ui/primitives";
import { PreferenceSelect } from "../ui/PreferenceSelect";

type ExportQuality = RenderRequest["quality"] | "best";

/** The export's quality levels, smallest first. Original quality encodes in software; High uses the computer's video encoder. */
/** While the loaded timeline is behind the project's head, caption export waits for it. */
export const LOADING_LATEST_EDIT = "Loading the latest edit before exporting captions…";

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
  const exported = job?.phase === "done" ? job : undefined;
  const exportedCurrentEdit = exported?.context === context;
  // For Resolve, Final Cut or Premiere: the folder for finishing the edit in another app. Otherwise the video or its captions.
  const [advanced, setAdvanced] = useState(previous?.format === "folder");
  const [plainFormat, setPlainFormat] = useState<"mp4" | "srt" | "vtt">(previous?.format === "srt" || previous?.format === "vtt" ? previous.format : "mp4");
  const format: ExportFile["format"] = advanced ? "folder" : plainFormat;
  const captions = format === "srt" || format === "vtt";
  const captionTrackChoices = useMemo(() => (current.timeline?.tracks ?? []).filter(t => t.kind === "caption" && !t.hidden), [current.timeline]);
  const [trackId, setTrackId] = useState(() => previous?.trackId && captionTrackChoices.some(t => t.id === previous.trackId) ? previous.trackId : captionTrackChoices[0]?.id ?? "");
  useEffect(() => {
    if (!captionTrackChoices.some(t => t.id === trackId)) setTrackId(captionTrackChoices[0]?.id ?? "");
  }, [captionTrackChoices, trackId]);
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
  // Sections an earlier render already encoded start the bar partway. That head start is shown as reused, not as speed.
  const reused = counting && busy.reused && Math.round(busy.reused.progress * 100) >= 1 ? busy.reused : undefined;
  // An export that stopped is explained here, so the menu's mark for it goes once this is open.
  const failed = job?.phase === "failed";
  useEffect(() => { if (failed) exportFailureSeen(current.id); }, [failed, current.id]);
  const range = format !== "folder" && customRange ? { start: snapToFrame(parseClock(start), fps), end: snapToFrame(parseClock(end), fps) } : undefined;
  const invalidRange = range && !(range.start >= 0 && range.end > range.start && range.end <= duration);
  const custom = format === "mp4" && (!!range || !!targetHeight || quality !== "delivery");
  const level = QUALITY[quality];
  const sampleOnly = IS_MOCK && custom;
  // The track picker reads the loaded timeline, and the export asks for the project's head. Until the two are the
  // same version, a track picked here may not be in the version that would be saved.
  const timelineBehind = captions && current.timeline?.version !== project.head;
  const noCaptionTrack = captions && captionTrackChoices.length === 0;
  // The picker can still hold a trackId after that track is gone; the effect below
  // clears it, but this render must not throw track_not_found first.
  const exportTrackId = captionTrackChoices.some(t => t.id === trackId) ? trackId : undefined;
  const noCaptionsInRange = captions && !noCaptionTrack && !invalidRange && current.timeline
    ? !captionExportHasCues(current.timeline, { trackId: exportTrackId, range })
    : false;
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
  const invalid = !hasCut || !duration || invalidRange || sampleOnly || timelineBehind || noCaptionTrack || noCaptionsInRange;
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
    void exportFile(current, { format, name, video, ...(captions && exportTrackId ? { trackId: exportTrackId } : {}) });
  };
  const switchTo = !busy && !exportedCurrentEdit && <button type="button" className="btn-quiet mr-auto" onClick={() => setAdvanced(!advanced)}>
    {advanced ? "Back" : "For Resolve, Final Cut or Premiere…"}
  </button>;
  return <Modal open title={advanced ? "Export for Resolve, Final Cut or Premiere" : "Export"} width={600} onClose={onClose} footer={running ? <>
    {busy.phase === "rendering" && <button type="button" className="btn-quiet" onClick={busy.cancel}>Cancel export</button>}
    <button type="button" className="btn-primary" onClick={onClose}>Continue editing</button>
  </> : <>
    {switchTo}
    <button type="button" className="btn-ghost" onClick={onClose}>{busy || exportedCurrentEdit ? "Close" : "Cancel"}</button>
    <button type="submit" form="export-working-cut" className="btn-primary" data-log-control="export" disabled={!!busy || !!invalid}>
      {failed ? "Retry" : "Export"}
    </button>
  </>}>
    <form id="export-working-cut" onSubmit={event => { event.preventDefault(); submit(); }}>
      <fieldset disabled={!!busy} className="min-w-0">
        {advanced ? <HandoffSummary summary={handoff} /> : <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
          <Field label="Format" htmlFor="export-format">
            <PreferenceSelect id="export-format" value={plainFormat} onChange={setPlainFormat}
              options={[
                { value: "mp4", label: "Video (.mp4)" },
                { value: "srt", label: "Captions (.srt)" },
                { value: "vtt", label: "Captions (.vtt)" },
              ]} />
          </Field>
          <Field label="Range" htmlFor="export-range">
            <PreferenceSelect id="export-range" value={customRange ? "custom" : "whole"}
              onChange={value => setCustomRange(value === "custom")} options={[{ value: "whole", label: "Whole video" }, { value: "custom", label: "Custom range" }]} />
          </Field>
          {range && <div className="hidden sm:block" />}
          {range && <>
            <Field label="From" htmlFor="export-start"><input className="field tnum" id="export-start" value={start} onChange={e => setStart(e.target.value)} /></Field>
            <Field label="To" htmlFor="export-end"><input className="field tnum" id="export-end" value={end} onChange={e => setEnd(e.target.value)} /></Field>
          </>}
          {captions && captionTrackChoices.length > 1 && <Field label="Track" htmlFor="export-track">
            <PreferenceSelect id="export-track" value={trackId} onChange={setTrackId}
              options={captionTrackChoices.map(track => ({ value: track.id, label: track.name }))} />
          </Field>}
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
    {!running && timelineBehind && <p className="mt-3 text-xs text-muted" role="status">{LOADING_LATEST_EDIT}</p>}
    {!running && <InlineError>{noCaptionTrack ? NO_CAPTION_TRACK :
      noCaptionsInRange ? NO_CAPTIONS_IN_RANGE :
      !hasCut ? "There’s no video to export yet." :
      invalidRange ? `Enter a range between 0:00 and ${playbackClock(duration)}, at least one frame long.` : sampleOnly ? "The isolated demo saves its included MP4. Custom video settings are available in library projects." : ""}</InlineError>}
    {busy && <div className="mt-3">
      {busy.phase === "choosing" ? <p className="text-xs text-muted" role="status">Choose a location…</p> :
        <ActivityProgress label={`Export progress for ${busy.file.name}`} value={counting ? busy.progress : undefined} reused={reused?.progress}>
          {busy.phase === "saving" ? (busy.file.format === "folder" ? "Saving the folder…" : "Saving file…") : busy.waiting ? "Waiting to start" : Math.round(busy.progress * 100) >= PICTURE_DONE ? "Finishing…"
            : `Exporting${busy.context !== context ? " an earlier version" : ""}${counting ? ` · ${pct(busy.progress)}` : ""}`}
        </ActivityProgress>}
      {reused && <p className="mt-1 flex flex-wrap gap-x-3.5 text-[11px] text-muted tnum" data-testid="export-reused">
        <span><span className="activity-progress-swatch" />Reused from an earlier export · {clock(reused.seconds)}</span>
        <span><span className="activity-progress-swatch is-new" />Exporting now</span>
      </p>}
      {running && <p className="mt-2 text-xs text-muted">Your export continues in the background while you edit.</p>}
    </div>}
    {exported && <p className="mt-3 flex items-center gap-2 text-xs" role="status">
      {exportedCurrentEdit && <Icon name="check" />}
      <span className="truncate" title={exported.path} data-log-private>{fileBaseName(exported.path)}</span>
      {!exportedCurrentEdit && <span className="shrink-0 text-muted">· Earlier edit</span>}
      <button className="btn-quiet shrink-0" data-log-control="reveal-export" onClick={() => { setRevealError(""); void desktop.revealPath(exported.path).catch(e => setRevealError(errorMessage(e))); }}>Show in folder</button>
    </p>}
    <InlineError>{(failed || revealError) && <span data-log-private>{failed ? job.error : revealError}</span>}</InlineError>
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
