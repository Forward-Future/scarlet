import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { ProjectSummary } from "@scarlet/shared";
import { errorMessage, IS_MOCK } from "../lib/client";
import { isDesktop } from "../lib/desktop";
import { plural } from "../lib/format";
import { isEditableTarget } from "../lib/hotkeys";
import { useProjectStore } from "../stores/project";
import { rememberProject } from "../lib/updatePlace";
import { Dropzone, type ImportSource } from "../components/media/UploadDropzone";
import { useImportTranscription } from "../components/media/TranscriptionAction";
import { WindowActions } from "../components/shell/WorkspaceNavigation";
import { TrashButton } from "../components/shell/TrashButton";
import { FfmpegSetupBanner } from "../components/shell/FfmpegSetup";
import { ConfirmDialog, EmptyState, ErrorState, Icon, InlineError, Loading, Modal, Spinner } from "../components/ui/primitives";
import { ProjectCard } from "./projects/ProjectCard";
import { FirstEditGuide, NewProjectModal } from "./projects/NewProjectModal";
import { FirstSignIn, providerList, SIGN_IN_ORDER } from "./projects/FirstSignIn";
import { isConfiguredAgent, useHostsStore } from "../stores/hosts";
import { useUiStore } from "../stores/ui";

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
  const [dialog, setDialog] = useState<{ kind: "guide" } | { kind: "create"; sources: ImportSource[] } | null>(null);
  const { notice, local } = useImportTranscription();
  // Where the grid puts what the list has in its heading row: the box that selects every project beside the layout
  // switch, and what is selected over the title.
  const [selectAllSlot, setSelectAllSlot] = useState<HTMLElement | null>(null);
  const [selectionSlot, setSelectionSlot] = useState<HTMLElement | null>(null);

  const begin = (sources: ImportSource[]) => setDialog({ kind: "create", sources });

  const empty = !list.length && !archived && status === "ready";
  // Nothing can be edited without a model, so while none is ready the first screen is signing in to one.
  const hostsStatus = useHostsStore(s => s.status);
  // The plans signed in, as one string so the store's answer only changes when they do.
  const signedInIds = useHostsStore(s => [...new Set(s.hosts.flatMap(h => h.agents).filter(isConfiguredAgent).map(a => a.id))].join(","));
  const signedIn = signedInIds ? signedInIds.split(",") : [];
  const signInLater = useUiStore(s => s.signInLater);
  const setSignInLater = useUiStore(s => s.setSignInLater);
  // Opened from Quick start before any plan is signed in ("first"), or to add another plan once one is ("add").
  const [signInAsked, setSignInAsked] = useState<"first" | "add" | null>(null);
  const canSignInHere = isDesktop() && !IS_MOCK;
  const needsSignIn = canSignInHere && !signedIn.length;
  const hostsKnown = hostsStatus === "ready" || hostsStatus === "error";
  const adding = canSignInHere && signInAsked === "add";
  const signIn = hostsKnown && (adding || (needsSignIn && (signInAsked === "first" || (empty && !signInLater))));
  const canAddPlan = canSignInHere && signedIn.length > 0 && SIGN_IN_ORDER.some(id => !signedIn.includes(id));
  const askSignIn = (mode: "first" | "add") => {
    setDialog(null);
    setSignInLater(false);
    setSignInAsked(mode);
  };
  const lookAround = () => {
    if (!adding) setSignInLater(true);
    setSignInAsked(null);
  };

  const navigate = useNavigate();
  const createSampleProject = useProjectStore(s => s.createSampleProject);
  const [creatingSample, setCreatingSample] = useState(false);
  const [sampleError, setSampleError] = useState("");
  const openSampleProject = async () => {
    if (creatingSample) return;
    setCreatingSample(true);
    setSampleError("");
    try {
      const project = await createSampleProject();
      navigate(`/p/${project.id}`);
    } catch (e) {
      setSampleError(errorMessage(e));
    } finally {
      setCreatingSample(false);
    }
  };

  const newProject = <button type="button" className="btn-primary" onClick={() => begin([])}>
    <Icon name="plus" size={15} /> New project
  </button>;
  const sampleProject = <button type="button" className="btn-ghost" disabled={creatingSample} onClick={() => void openSampleProject()}>
    {creatingSample ? <><Spinner /> Creating sample…</> : "Try a sample project"}
  </button>;
  const quickStart = <button type="button" className="btn-quiet" aria-haspopup="dialog" onClick={() => setDialog({ kind: "guide" })}>
    Quick start {empty && <Icon name="arrow" size={14} />}
  </button>;

  return (
    <div className="flex-1 overflow-y-auto">
      <Dropzone onFiles={sources => begin(Array.from(sources))} onPaths={begin} label="Create a project from these files" notice={notice} className="min-h-full">
        <main className={empty || signIn ? "library-page library-welcome" : "library-page"}>
          <header className="library-heading">
            <h1>{signIn ? "Scarlet" : "Projects"}</h1>
            <span ref={setSelectionSlot} className="contents" />
            <div className="flex-1" />
            {!signIn && list.length > 0 && quickStart}
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
            {!signIn && !empty && newProject}
            <WindowActions />
          </header>
          <FfmpegSetupBanner />
          {signIn ? (
            <FirstSignIn adding={adding} later={lookAround} laterLabel={adding ? "Done" : empty ? "Look around first" : "Back to projects"} />
          ) : ((status === "loading" || status === "idle") && !list.length) || (empty && needsSignIn && !hostsKnown && !signInLater) ? (
            // Wait for the library, and for whether a model is ready, before offering a first project.
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
              {signedIn.some(id => SIGN_IN_ORDER.includes(id)) && <p className="first-signed-in">✓ Signed in with {providerList(signedIn)}
                {canAddPlan && <> · <button type="button" className="first-edit-link" onClick={() => askSignIn("add")}>Add another</button></>}</p>}
              <div className="first-edit-actions">{newProject}{sampleProject}{quickStart}</div>
              {sampleError && <InlineError>{sampleError}</InlineError>}
            </section>
          ) : (
            <ProjectCollection key={String(archived)} projects={projects} view={view} archived={archived} notice={notice}
              selectionSlot={selectionSlot} selectAllSlot={selectAllSlot} />
          )}
        </main>
      </Dropzone>

      <Modal open={dialog?.kind === "guide"} onClose={() => setDialog(null)} title="Quick start" width={480} footer={newProject}>
        <FirstEditGuide onSignIn={needsSignIn ? () => askSignIn("first") : undefined} />
      </Modal>
      {dialog?.kind === "create" && (
        <NewProjectModal initialFiles={dialog.sources} empty={empty} notice={notice} local={local} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
