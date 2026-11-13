import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import type { ProjectActivity, ProjectSummary } from "@scarlet/shared";
import { api, errorMessage, IS_DESKTOP } from "../lib/client";
import { absTime, clock, plural, relTime } from "../lib/format";
import { isEditableTarget } from "../lib/hotkeys";
import { useProjectStore } from "../stores/project";
import { useUiStore } from "../stores/ui";
import { matchFirstClip } from "../lib/firstClipFormat";
import { rememberProject } from "../lib/updatePlace";
import { useHoverFrames } from "../lib/hoverFrames";
import { Dropzone, enqueueImports, filename, UploadList, useImportCount, useUploader, type ImportSource } from "../components/media/UploadDropzone";
import { ACCEPTED_MEDIA, MEDIA_FORMAT_HINT } from "../lib/upload";
import { desktop } from "../lib/desktop";
import { useImportTranscription } from "../components/media/TranscriptionAction";
import { Dropdown, MenuItem, WindowActions } from "../components/shell/WorkspaceNavigation";
import { TrashButton } from "../components/shell/TrashButton";
import { ConfirmDialog, EmptyState, ErrorState, Field, Icon, InlineError, Loading, Modal, Spinner } from "../components/ui/primitives";

/**
 * Under a project's name: how long its video runs, then how many files it has. Its frame is there only when it isn't
 * 16:9, which nearly every project is, and reads as its size: beside a length, "9:16" reads as a second time. Its
 * frame rate is in Project settings.
 */
function projectFacts(p: ProjectSummary): string[] {
  const { width, height } = p.settings;
  return [p.duration ? clock(p.duration) : "", width * 9 === height * 16 ? "" : `${width}×${height}`, plural(p.mediaCount, "file")].filter(Boolean);
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
        if (live) setSrc(v ? api.frameUrl(v.id, Math.min(2, (v.duration ?? 4) / 2), 480) : undefined);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, mediaCount, poster]);
  return poster === undefined ? src : poster ? api.frameUrl(poster.mediaId, poster.time, 480) : undefined;
}

/**
 * What Scarlet is doing in the project, as the engine counted it, in a few words: "Editing", "Transcribing 42%",
 * "Caching paused". A job under way gives how far it has got once there is a figure, and never says 100%.
 */
export function activityLabel(activity: ProjectActivity): string {
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

  async function save(patch: { name?: string; archived?: boolean }) {
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

function ProjectCard({ p, notice, selected, selecting, onSelect }: {
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

function ProjectCollection({ projects, view, archived, notice, selectionSlot, selectAllSlot }: {
  projects: ProjectSummary[]; view: "list" | "grid"; archived: boolean; notice: string;
  selectionSlot: HTMLElement | null; selectAllSlot: HTMLElement | null;
}) {
  const update = useProjectStore(s => s.updateProject);
  const remove = useProjectStore(s => s.deleteProject);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [batchSize, setBatchSize] = useState(0);
  const busy = batchSize > 0;
  const [trashOpen, setTrashOpen] = useState(false);
  const [error, setError] = useState("");
  const targets = useMemo(() => projects.filter(p => selected.has(p.id)), [projects, selected]);
  const count = targets.length;

  useEffect(() => {
    if (selected.size !== count) setSelected(new Set(targets.map(p => p.id)));
    if (!count) {
      anchor.current = null;
      setTrashOpen(false);
    }
  }, [count, projects.length, selected, targets]);

  function select(id: string, range: boolean) {
    if (busy) return;
    const next = new Set(selected);
    const from = projects.findIndex(p => p.id === anchor.current);
    if (range && from >= 0) {
      const to = projects.findIndex(p => p.id === id);
      for (const p of projects.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(p.id);
    } else {
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchor.current = id;
    }
    setError("");
    setSelected(next);
  }

  function selectVisible(all: boolean) {
    anchor.current = null;
    setError("");
    setSelected(new Set(all ? projects.map(p => p.id) : []));
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (busy || e.defaultPrevented || e.altKey || e.shiftKey ||
        document.querySelector('dialog[open], [role="dialog"], [role="menu"], [data-shortcut-overlay]')) return;
      if (isEditableTarget(e.target) && !(e.target instanceof HTMLInputElement && e.target.type === "checkbox")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectVisible(true);
      } else if (e.key === "Escape" && count) {
        e.preventDefault();
        selectVisible(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projects, busy, count]);

  async function apply(action: "archive" | "trash") {
    if (busy || !count) return;
    setBatchSize(count);
    setError("");
    const failed = new Set<string>();
    const errors: string[] = [];
    for (const project of targets) {
      try {
        if (action === "trash") await remove(project.id);
        else await update({ archived: !archived }, project.id);
      } catch (e) {
        failed.add(project.id);
        errors.push(`${project.name}: ${errorMessage(e)}`);
      }
    }
    setSelected(failed);
    setError(errors.join(" · "));
    setBatchSize(0);
    void useProjectStore.getState().loadList();
  }

  // The box that selects every project shown. The list has it in its heading row, in line with each row's own box. The
  // grid has no heading row, so there it sits beside the layout switch. No row is kept for it.
  const selectAll = (className: string) => <label className={className} title="Select all visible projects">
    <input type="checkbox" aria-label="Select all visible projects" disabled={busy} checked={count === projects.length}
      ref={box => { if (box) box.indeterminate = count > 0 && count < projects.length; }} onChange={e => selectVisible(e.target.checked)} />
  </label>;
  // How many are selected and what can be done with them, there only while something is. It sits on the row that
  // holds that box, over the row's words: the list's headings, or the page's title in the grid. It takes no room of
  // its own, so no project moves from under the pointer when it comes in. In the grid it is outside the fieldset, so
  // its buttons are turned off here while a batch runs.
  const selection = count > 0 && <div className="library-selection-bar">
    <span aria-hidden>{count} selected</span>
    <button className="btn-ghost" disabled={busy} onClick={() => void apply("archive")}>{archived ? "Unarchive" : "Archive"}</button>
    <button className="btn-ghost" disabled={busy} onClick={() => setTrashOpen(true)}><Icon name="trash" size={14} /> Move to Trash</button>
    <button className="btn-quiet" disabled={busy} onClick={() => selectVisible(false)}>Clear selection</button>
    {busy && <Spinner />}
  </div>;
  return <>
    {view === "grid" && selectionSlot && createPortal(selection, selectionSlot)}
    {view === "grid" && selectAllSlot && createPortal(selectAll("library-select-all"), selectAllSlot)}
    <fieldset disabled={busy} className="min-w-0" aria-label="Project library">
      <span className="sr-only" role="status">{count ? `${count} selected` : ""}</span>
      <InlineError>{error}</InlineError>
      <div className={`project-collection ${view}`}>
        {/* The column of what needs the editor has no heading: a row that has something there says so in its own words. */}
        {view === "list" && <div className="project-columns">
          {selectAll("project-selector")}
          <span aria-hidden>Project</span><span /><span aria-hidden>Last edited</span>
          {selection}
        </div>}
        {projects.map(p => <ProjectCard key={p.id} p={p} notice={notice} selected={selected.has(p.id)}
          selecting={count > 0 || busy} onSelect={range => select(p.id, range)} />)}
      </div>
    </fieldset>
    {trashOpen && count > 0 && <ConfirmDialog open danger onClose={() => { if (!busy) setTrashOpen(false); }}
      title={`Move ${plural(batchSize || count, "project")} to Trash?`} confirmLabel="Move to Trash"
      body="Projects and their footage can be restored from Trash for 30 days."
      onConfirm={() => apply("trash")} />}
  </>;
}

export function ImportUrlModal({ projectId, open, notice, onClose }: { projectId: string; open: boolean; notice: string; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const { startPaths } = useUploader(projectId);
  // The link joins the project's queue like a dropped file, and the dialog goes at once: a download can take minutes.
  // Media shows it being added once its turn comes, counts it in "File 1 of 2" while another is added first, and
  // says there if it failed. As a file does, the first video added to a project that is still new gives it its format.
  const run = () => {
    const link = url.trim();
    if (!link) return;
    void startPaths([link]);
    setUrl("");
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add from a link"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="import-link" className="btn-primary" disabled={!url.trim()}>
            Add
          </button>
        </>
      }
    >
      {notice && <p className="text-muted text-[12px] mb-3">{notice}</p>}
      <form id="import-link" onSubmit={e => { e.preventDefault(); run(); }}>
        <Field label="Link or file path" htmlFor="import-url">
          <input id="import-url" className="field" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://drive.google.com/file/d/…" autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

function FirstEditGuide() {
  return (
    <>
      <ol className="first-edit-steps">
        <li>
          <h3>Add your footage</h3>
          <p>Drop a clip onto Projects or choose <strong>New project</strong>.</p>
        </li>
        <li>
          <h3>Ask for an edit</h3>
          <p>Close Media, then type or say “Trim the silence before my first word.”</p>
          <p>If prompted, connect Claude or ChatGPT under <strong>More → Set up a model</strong>.</p>
        </li>
        <li>
          <h3>Play it back</h3>
          <p>Play the edit on the timeline. Choose <strong>Revise</strong> to adjust it or <strong>Export</strong> to save an MP4.</p>
        </li>
      </ol>
      <details className="first-edit-skills">
        <summary>Teach Scarlet your editing style <Icon name="chevron" size={13} /></summary>
        <p>To reuse editing instructions, type <strong>/</strong> in chat and choose <strong>Create a skill</strong>.</p>
        <p>Scarlet can also suggest a rule when you ask for an edit like this.</p>
        <blockquote>“For interviews, always leave a beat after a difficult question.”</blockquote>
        <p>Review the rule in <strong>More → Learnings</strong>. Choose a skill and press <strong>Approve</strong> to save it.</p>
      </details>
    </>
  );
}

export function ProjectsPage() {
  // Back at the library: a quit from here reopens the library, not the last project.
  useEffect(() => rememberProject(null), []);
  const list = useProjectStore((s) => s.list);
  const status = useProjectStore((s) => s.listStatus);
  const error = useProjectStore((s) => s.listError);
  const loadList = useProjectStore((s) => s.loadList);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) void loadList(); };
    // The first load doesn't wait for the window to show: a library opened behind another window is there when looked at.
    void loadList();
    // The library can stay open while a background edit finishes.
    const timer = window.setInterval(refresh, 10_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadList]);
  // "Last edited" is worded from now. An unchanged refresh draws nothing, so the page redraws each minute.
  const [, setMinute] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setMinute(n => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const createProject = useProjectStore((s) => s.createProject);
  const navigate = useNavigate();
  const [archived, setArchived] = useState(false);
  const projects = useMemo(() => list.filter(p => Boolean(p.archived) === archived), [list, archived]);
  const [view, setView] = useState<"list" | "grid">(() => {
    try { return localStorage.getItem("scarlet.projectView") === "grid" ? "grid" : "list"; }
    catch { return "list"; }
  });
  const chooseView = (next: typeof view) => {
    setView(next);
    try { localStorage.setItem("scarlet.projectView", next); } catch { /* Storage is optional. */ }
  };
  const [dialog, setDialog] = useState<"create" | "guide" | null>(null);
  const [name, setName] = useState("");
  const [files, setFiles] = useState<ImportSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { notice } = useImportTranscription();
  // Where the grid puts what the list has in its heading row: the box that selects every project beside the layout
  // switch, and what is selected over the title.
  const [selectAllSlot, setSelectAllSlot] = useState<HTMLElement | null>(null);
  const [selectionSlot, setSelectionSlot] = useState<HTMLElement | null>(null);

  /** A project is named for its first video until the editor names it. */
  const nameFrom = (sources: ImportSource[]) => filename(sources[0]!).replace(/\.[^.]+$/, "") || "Untitled project";
  // The name the first video last gave, so another selection renames a project the editor hasn't named themselves.
  const given = useRef("");

  const begin = (sources: ImportSource[]) => {
    setFiles(sources);
    given.current = sources.length ? nameFrom(sources) : "";
    setName(given.current);
    setErr(null);
    setDialog("create");
  };

  const selectFootage = (sources: ImportSource[]) => {
    if (!sources.length) return;
    setFiles(sources);
    // Videos chosen in the dialog name the project as videos dropped on the library do. A name the editor typed stays.
    const was = given.current, next = nameFrom(sources);
    given.current = next;
    setName(typed => !typed.trim() || typed === was ? next : typed);
  };

  /** Videos dropped on the open dialog join the ones chosen. */
  const addFootage = (sources: ImportSource[]) => {
    if (!busy) selectFootage([...files, ...sources.filter(source => !files.includes(source))]);
  };

  const pick = async () => {
    if (!IS_DESKTOP) {
      fileInput.current?.click();
      return;
    }
    setErr(null);
    try {
      const paths = await desktop.pickFiles();
      selectFootage(paths);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const project = await createProject({ name: name.trim() });
      if (empty) useUiStore.getState().offerFirstEditHint(project.id);
      void enqueueImports(project.id, files, matchFirstClip(project));
      navigate(`/p/${project.id}?panel=media`);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const empty = !list.length && !archived && status === "ready";
  const newProject = <button type="button" className="btn-primary" onClick={() => begin([])}>
    <Icon name="plus" size={15} /> New project
  </button>;
  const quickStart = <button type="button" className="btn-quiet" aria-haspopup="dialog" onClick={() => setDialog("guide")}>
    Quick start {empty && <Icon name="arrow" size={14} />}
  </button>;

  return (
    <div className="flex-1 overflow-y-auto">
      <Dropzone onFiles={sources => begin(Array.from(sources))} onPaths={begin} label="Create a project from these files" notice={notice} className="min-h-full">
        <main className={empty ? "library-page library-welcome" : "library-page"}>
          <header className="library-heading">
            <h1>Projects</h1>
            <span ref={setSelectionSlot} className="contents" />
            <div className="flex-1" />
            {list.length > 0 && quickStart}
            {(archived || list.some(p => p.archived)) && <div className="view-switch library-filter" role="group" aria-label="Project status">
              <button aria-pressed={!archived} onClick={() => setArchived(false)}>Active</button>
              <button aria-pressed={archived} onClick={() => setArchived(true)}>Archived</button>
            </div>}
            <TrashButton />
            <span ref={setSelectAllSlot} className="contents" />
            {list.length > 0 && <div className="view-switch" role="group" aria-label="Project layout">
              <button aria-label="List view" aria-pressed={view === "list"} title="List view" onClick={() => chooseView("list")}><Icon name="diff" size={15} /></button>
              <button aria-label="Grid view" aria-pressed={view === "grid"} title="Grid view" onClick={() => chooseView("grid")}><Icon name="library" size={14} /></button>
            </div>}
            {!empty && newProject}
            <WindowActions />
          </header>
          {(status === "loading" || status === "idle") && !list.length ? (
            // Wait for the library before offering a first project.
            <Loading />
          ) : status === "error" && !list.length ? (
            <ErrorState body={error ?? undefined} onRetry={() => void loadList(true)} />
          ) : archived && !projects.length ? (
            <EmptyState title="No archived projects" action={<button className="btn-ghost" onClick={() => setArchived(false)}>View active projects</button>} />
          ) : list.length > 0 && !projects.length ? (
            <EmptyState title="No active projects" action={<button className="btn-ghost" onClick={() => setArchived(true)}>View archived projects</button>} />
          ) : empty ? (
            <section className="library-first-edit" aria-labelledby="first-edit-title">
              <h2 id="first-edit-title">Make your first edit</h2>
              <p>Drop your footage here, then tell Scarlet what you’d like to change.</p>
              <div className="first-edit-actions">{newProject}{quickStart}</div>
            </section>
          ) : (
            <ProjectCollection key={String(archived)} projects={projects} view={view} archived={archived} notice={notice}
              selectionSlot={selectionSlot} selectAllSlot={selectAllSlot} />
          )}
        </main>
      </Dropzone>

      <Modal open={dialog === "guide"} onClose={() => setDialog(null)} title="Quick start" width={480} footer={newProject}>
        <FirstEditGuide />
      </Modal>
      <Modal
        open={dialog === "create"}
        onClose={() => { if (!busy) { setDialog(null); setErr(null); } }}
        title="New project"
        footer={
          <>
            <button className="btn-ghost" disabled={busy} onClick={() => { setDialog(null); setErr(null); }}>Cancel</button>
            <button type="submit" form="new-project" className="btn-primary" disabled={!name.trim() || busy}>
              {busy && <Spinner className="size-3" />} {files.length ? "Create and import" : "Create project"}
            </button>
          </>
        }
      >
        <form id="new-project" onSubmit={e => { e.preventDefault(); void create(); }}>
          <Dropzone onFiles={sources => addFootage(Array.from(sources))} onPaths={addFootage} label="Drop to add videos" notice={notice}>
            <Field label="Project name" htmlFor="np-name">
              <input id="np-name" className="field" value={name} required disabled={busy} onChange={e => setName(e.target.value)} placeholder="Enter a name" />
            </Field>
            <fieldset>
              <legend className="label">Media files <span className="text-dim">(optional)</span></legend>
              <input ref={fileInput} type="file" hidden multiple accept={ACCEPTED_MEDIA} onChange={e => {
                if (e.target.files) selectFootage(Array.from(e.target.files));
                e.target.value = "";
              }} />
              <button type="button" className="btn-ghost" aria-describedby="np-file-types" disabled={busy} onClick={() => void pick()}>
                {files.length ? "Change selection…" : "Choose files…"}
              </button>
              {files.length > 0 && <button type="button" className="btn-quiet" disabled={busy} onClick={() => setFiles([])}>Clear</button>}
              <p id="np-file-types" className="mt-2 text-[12px] text-muted">{MEDIA_FORMAT_HINT}</p>
            </fieldset>
            {files.length > 0 && <>
              <ul aria-label="Selected files" className="mt-2 max-h-28 overflow-y-auto text-[12px]">
                {files.map((file, index) => <li key={index} className="break-all">{filename(file)}</li>)}
              </ul>
              <p className="mt-2 text-[12px] text-muted">The project format will match the first video.</p>
              <p className="mt-2 text-[12px] text-muted">{notice}</p>
            </>}
            <InlineError>{err}</InlineError>
          </Dropzone>
        </form>
      </Modal>
    </div>
  );
}
