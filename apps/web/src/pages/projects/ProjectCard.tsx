import { Fragment, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link } from "react-router-dom";
import type { ProjectActivity, ProjectSummary } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { absTime, clock, plural, relTime } from "../../lib/format";
import { useHoverFrames } from "../../lib/hoverFrames";
import { useProjectStore } from "../../stores/project";
import { interactiveFrameUrl } from "../../components/review/thumbs";
import { Dropzone, UploadList, useImportCount, useUploader } from "../../components/media/UploadDropzone";
import { Dropdown, MenuItem } from "../../components/shell/WorkspaceNavigation";
import { ConfirmDialog, Field, Icon, InlineError, Modal } from "../../components/ui/primitives";

/**
 * Under a project's name: how long its video runs, then how many files it has. Its frame is there only when it isn't
 * 16:9, which nearly every project is, and reads as its size: beside a length, "9:16" reads as a second time. Its
 * frame rate is in Project settings.
 */
function projectFacts(p: ProjectSummary): string[] {
  const { width, height } = p.settings;
  return [p.duration ? clock(p.duration) : "", width * 9 === height * 16 ? "" : `${width}×${height}`,
    plural(p.mediaCount, "file")].filter(Boolean);
}

/** First video in the project, for a poster frame. */
function usePoster(projectId: string, mediaCount: number, poster: ProjectSummary["poster"]): string | undefined {
  const [src, setSrc] = useState<string | undefined>();
  useEffect(() => {
    if (poster !== undefined) return;
    if (!mediaCount) { setSrc(undefined); return; }
    let live = true;
    api
      .media(projectId)
      .then(({ media }) => {
        const v = media.find((m) => m.kind === "video");
        if (live) setSrc(v ? interactiveFrameUrl(api.frameUrl(v.id, Math.min(2, (v.duration ?? 4) / 2), 480)) : undefined);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, mediaCount, poster]);
  // The library's pictures are the editor's own view. Behind a pass's frames they held the window's connections,
  // and the library's list waited 11 s for one (2026-11-12).
  return poster === undefined ? src : poster ? interactiveFrameUrl(api.frameUrl(poster.mediaId, poster.time, 480)) : undefined;
}

/**
 * What Scarlet is doing in the project, as the engine counted it, in a few words: "Editing", "Transcribing 42%",
 * "Caching paused". A job under way gives how far it has got once there is a figure, and never says 100%.
 */
function activityLabel(activity: ProjectActivity): string {
  const name = { editing: "Editing", importing: "Importing", transcribing: "Transcribing", caching: "Caching" }[activity.kind];
  if (activity.paused) return `${name} paused`;
  if (activity.kind === "importing") return `Importing ${plural(activity.count ?? 1, "file")}`;
  return activity.fraction === undefined ? name : `${name} ${Math.min(99, Math.floor(activity.fraction * 100))}%`;
}

/** The project's status under its details while Scarlet works on it, led by a ring drawn as the chat's step under way is. */
function ProjectActivityLine({ p }: { p: ProjectSummary }) {
  const activity = p.activity ?? [];
  if (!activity.length) return null;
  const working = activity.some(a => !a.paused);
  return <p className="project-activity" id={`project-activity-${p.id}`}>
    <span className="project-activity-mark" data-state={working ? "working" : "paused"} aria-hidden />
    {activity.map((a, i) => <span key={a.kind} className={a.kind === "editing" ? "is-editing" : undefined}>
      {i > 0 && <i aria-hidden>·</i>}{activityLabel(a)}
    </span>)}
  </p>;
}

function ProjectActions({ project }: { project: ProjectSummary }) {
  const update = useProjectStore(s => s.updateProject);
  const remove = useProjectStore(s => s.deleteProject);
  const [dialog, setDialog] = useState<"rename" | "trash" | null>(null);
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(patch: Partial<Pick<ProjectSummary, "name" | "archived" | "mediaPaused">>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await update(patch, project.id);
      setDialog(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="project-actions">
      <Dropdown label={`Actions for ${project.name}`} align="right" width={176}
        button={<span className="btn-icon" title="Project actions"><Icon name="more" size={18} /></span>}>
        {close => <>
          <MenuItem onClick={() => { close(); setName(project.name); setError(""); setDialog("rename"); }}>Rename</MenuItem>
          <MenuItem onClick={() => { close(); void save({ archived: !project.archived }); }}>{project.archived ? "Unarchive" : "Archive"}</MenuItem>
          {(project.mediaPaused || project.activity?.some(a => a.kind !== "editing")) && (
            <MenuItem disabled={busy} title={project.mediaPaused ? "Resume media processing" : "Pause media processing"}
              onClick={() => { close(); void save({ mediaPaused: !project.mediaPaused }); }}>
              {project.mediaPaused ? "Resume" : "Pause"}
            </MenuItem>
          )}
          <MenuItem danger onClick={() => { close(); setError(""); setDialog("trash"); }}>Move to Trash</MenuItem>
        </>}
      </Dropdown>
    </div>
    {!dialog && <InlineError>{error}</InlineError>}
    {/* A rename given up on takes its failure with it: left behind, it would show under the project's row. */}
    <Modal open={dialog === "rename"} onClose={() => { if (!busy) { setDialog(null); setError(""); } }} title="Rename project">
      <form onSubmit={e => { e.preventDefault(); if (name.trim()) void save({ name: name.trim() }); }}>
        <Field label="Project name" htmlFor={`rename-${project.id}`}>
          <input autoFocus id={`rename-${project.id}`} className="field" value={name} onChange={e => setName(e.target.value)} />
        </Field>
        <InlineError>{error}</InlineError>
        <div className="flex justify-end gap-2 mt-3">
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => { setDialog(null); setError(""); }}>Cancel</button>
          <button className="btn-primary" disabled={busy || !name.trim()}>Save</button>
        </div>
      </form>
    </Modal>
    {dialog === "trash" && <ConfirmDialog open onClose={() => setDialog(null)} danger
      title={`Move “${project.name}” to Trash?`} confirmLabel="Move to Trash"
      body="You can restore this project and its footage from Trash for 30 days."
      onConfirm={() => remove(project.id)} />}
  </>;
}

export function ProjectCard({ p, notice, selected, selecting, onSelect }: {
  p: ProjectSummary; notice: string; selected: boolean; selecting: boolean; onSelect: (range: boolean) => void;
}) {
  const { items, start, startPaths, dismiss } = useUploader(p.id, p);
  const pending = useImportCount(p.id);
  const poster = usePoster(p.id, p.mediaCount, p.poster);
  const [failedPoster, setFailedPoster] = useState<string>();
  const showsPoster = !!poster && poster !== failedPoster;
  const { frame, ...flip } = useHoverFrames(p.id, p.poster, showsPoster);
  const portrait = p.settings.height > p.settings.width;
  const checkbox = useRef<HTMLInputElement>(null);
  const checkboxId = `project-select-${p.id}`;
  function onRowClick(e: ReactMouseEvent) {
    if (selecting || e.metaKey || e.ctrlKey || e.shiftKey) {
      e.preventDefault();
      checkbox.current?.focus();
      onSelect(e.shiftKey);
    }
  }
  const contents = <>
    <div className="project-still">
      {showsPoster ? <>
        <img src={poster} loading="lazy" decoding="async" alt="" className={portrait ? "portrait" : ""} onError={() => setFailedPoster(poster)} />
        {/* While the pointer rests on the card, a few frames of the footage play over the poster. */}
        {frame && <img src={frame} alt="" className={portrait ? "project-flip portrait" : "project-flip"} />}
      </> : (
        <div className="project-placeholder"><Icon name="film" size={34} /></div>
      )}
    </div>
    <div className="project-caption">
      <h2 title={p.name}>{p.name}</h2>
      <p id={`project-meta-${p.id}`}>{projectFacts(p).map((fact, i) => <Fragment key={i}>{i > 0 && <span>·</span>}{fact}</Fragment>)}</p>
      <ProjectActivityLine p={p} />
    </div>
    {/* The count and the words of the project's chat: the calls, questions and suggestions that wait on the editor. */}
    <div className="project-review" id={`project-review-${p.id}`}>
      {p.pendingChanges > 0
        ? <span className="review-badge"><i aria-hidden />{p.pendingChanges} {p.pendingChanges === 1 ? "needs" : "need"} you</span>
        : <span className="sr-only">Nothing needs you</span>}
    </div>
    <time className="project-date" dateTime={p.updatedAt} title={absTime(p.updatedAt)}>{relTime(p.updatedAt)}</time>
  </>;
  return (
    <Dropzone onFiles={start} onPaths={startPaths} label={`Add files to ${p.name}`} notice={notice} className={`project-card${selected ? " is-selected" : ""}`}>
      <div className="project-entry" {...flip}>
        <label className="project-selector" title={`Select ${p.name} · Shift-click to select a range`}>
          <input ref={checkbox} id={checkboxId} type="checkbox" aria-label={`Select ${p.name}`} checked={selected}
            onChange={e => onSelect((e.nativeEvent as MouseEvent).shiftKey)} />
        </label>
        {selecting
          ? <label className="project-link" htmlFor={checkboxId} onClickCapture={onRowClick}>{contents}</label>
          : <Link to={`/p/${p.id}`} className="project-link" aria-label={`Open ${p.name}`}
              aria-describedby={`project-meta-${p.id}${p.activity?.length ? ` project-activity-${p.id}` : ""} project-review-${p.id}`} onClick={onRowClick}>{contents}</Link>}
        {!selecting && <ProjectActions project={p} />}
      </div>
      {pending > 0 && <small role="status">Adding {plural(pending, "file")}…</small>}
      <UploadList items={items} onDismiss={dismiss} />
    </Dropzone>
  );
}
