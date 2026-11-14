import { lazy, Suspense, useEffect, useLayoutEffect, useState } from "react";
import { ScarletApiError, type TrashedProject } from "@scarlet/shared";
import { Link, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, errorMessage } from "../../lib/client";
import { useHotkeys } from "../../lib/hotkeys";
import { player } from "../../lib/player";
import { leaveProject } from "../../lib/realtime";
import { rememberProject } from "../../lib/updatePlace";
import { resumeImports } from "../media/UploadDropzone";
import { usePlayerStore } from "../../stores/player";
import { useProjectStore } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import { NotePopover } from "../agent/NotePopover";
import { DialogSurface, EmptyState, ErrorState, InlineError, Loading, Modal } from "../ui/primitives";
import { BootSplash, startup } from "./BootSplash";
import { DesktopAgents } from "./DesktopSettings";
import { ModelSettings } from "./ModelSettings";
import { ProjectSettingsDrawer } from "./ProjectSettingsDrawer";

const SkillCreator = lazy(async () => ({ default: (await import("../../pages/SkillEditorPage")).SkillEditorPage }));

function TrashedProjectView({ project }: { project: TrashedProject }) {
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setRestoring(true);
    setError(null);
    try {
      await api.restoreProject(project.id);
    } catch (err) {
      // Another window may already have restored the project, or it may have expired.
      if (!(err instanceof ScarletApiError && err.status === 404)) {
        setError(errorMessage(err));
        setRestoring(false);
        return;
      }
    }
    const store = useProjectStore.getState();
    void store.loadList();
    if (store.trashedProject?.id === project.id) await store.load(project.id);
  }

  return (
    <EmptyState icon="trash" title="This project is in Trash" body={`Restore “${project.name}” to open it here.`}
      action={<>
        <Link className="btn-quiet" to="/">All projects</Link>
        <button className="btn-primary" disabled={restoring} onClick={restore}>
          {restoring ? "Restoring…" : "Restore project"}
        </button>
        <InlineError>{error}</InlineError>
      </>}
    />
  );
}

export function ProjectLayout() {
  const { id = "" } = useParams();
  const load = useProjectStore((s) => s.load);
  const status = useProjectStore((s) => s.status);
  const error = useProjectStore((s) => s.error);
  const opened = useProjectStore(s => !!id && s.current?.id === id);
  const projectLoad = useProjectStore(s => s.current?.id === id ? s.current?.loadRevision : undefined);
  const reviewStatus = useProjectStore(s => s.current?.reviewStatus);
  const reviewError = useProjectStore(s => s.current?.reviewError);
  const trashedProject = useProjectStore((s) => s.trashedProject);
  const navigate = useNavigate();
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const creatingSkill = query.has("createSkill");
  const backToEdit = () => {
    const next = new URLSearchParams(location.search);
    next.delete("createSkill");
    void navigate({ pathname: location.pathname, search: next.toString(), hash: location.hash }, { replace: true });
  };
  const setup = useUiStore((s) => s.agentSetupOpen);
  const closeSetup = () => {
    useUiStore.getState().setAgentSetupOpen(false);
    useUiStore.getState().focusComposer();
  };
  useEffect(() => { if (setup || creatingSkill) player.pause(); }, [setup, creatingSkill]);

  useEffect(() => {
    if (id) void load(id);
    return () => leaveProject(id);
  }, [id, load]);

  useEffect(() => {
    const release = () => useUiStore.getState().setVoiceHold(false);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("blur", release);
      release();
    };
  }, [id]);

  // Scarlet reopens the project that was on screen when it closed. The library forgets it once it is shown: this
  // view also unmounts while the engine restarts or the app quits, which must not forget the project.
  useEffect(() => {
    if (!opened || !id) return;
    rememberProject(id);
    void resumeImports(id, useProjectStore.getState().current?.media ?? []);
  }, [opened, id, projectLoad]);

  // A playhead, pinned transcript span and draft belong to one project.
  useLayoutEffect(() => () => {
    usePlayerStore.setState({ time: 0, duration: 0, playing: false, rate: 1 });
    useUiStore.getState().openDraft(null);
    // Project settings left open by a shortcut to another page would be open again on the way back, or on the next project.
    useUiStore.setState({ notePopover: null, agentSetupOpen: false, projectSettingsOpen: false });
  }, [id]);

  // Hold V: push-to-talk. Whoever owns the voice (composer or the item in focus) listens.
  useHotkeys(
    (e) => {
      const ui = useUiStore.getState();
      if (e.key === "v" || e.key === "V") {
        if (!e.repeat) ui.setVoiceHold(true);
        e.preventDefault();
      }
    },
    (e) => {
      if (e.key === "v" || e.key === "V") useUiStore.getState().setVoiceHold(false);
    },
  );

  const needsHistory = /\/review\/?$/.test(location.pathname) || ["thread", "item", "note", "audition", "cuts"].some(key => query.has(key)) || query.get("panel") === "history";
  const failed = trashedProject?.id === id || (status === "error" && !opened);
  const waiting = failed ? null : !opened ? "Opening project…" : needsHistory && reviewStatus === "loading" ? "Loading edit history…" : null;
  // Scarlet reopening its last project is still starting, so the startup screen stays up until the project can show
  // or says why it can't. A project opened after that waits under a line of its own.
  if (waiting) return startup.done ? <Loading label={waiting} /> : <BootSplash />;
  startup.done = true;
  if (trashedProject?.id === id) return <TrashedProjectView key={id} project={trashedProject} />;
  if (!opened) return <div><Link to="/" className="btn-quiet m-4">← Projects</Link><ErrorState title="Couldn’t open the project" body={error ?? undefined} onRetry={() => void load(id)} /></div>;
  if (needsHistory && reviewStatus) return <ErrorState title="Couldn’t load edit history" body={reviewError} onRetry={() => void load(id)} />;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Outlet key={id} />
      {/* Keep the project mounted so the draft, its target and any queued request being reworded stay in place. */}
      {creatingSkill && <Suspense fallback={null}>
        <DialogSurface aria-label="Create a skill" onDismiss={backToEdit}
          className="studio-dialog fixed inset-0 m-auto flex h-[80dvh] max-h-full w-[min(820px,95%)] flex-col overflow-hidden card text-fg shadow-2xl backdrop:bg-black/60">
          <SkillCreator onReturnToEdit={backToEdit} />
        </DialogSurface>
      </Suspense>}
      <NotePopover />
      <ProjectSettingsDrawer onDeleted={() => navigate("/")} />
      <Modal open={!!setup} onClose={closeSetup} title={setup === "models" ? "Choose models" : "Sign in"} width={560}
        footer={<button className="btn-primary" onClick={closeSetup}>Back to project</button>}>
        {setup === "models" ? <ModelSettings onSignIn={() => useUiStore.getState().setAgentSetupOpen(true)} /> : <DesktopAgents onConnected={closeSetup} />}
      </Modal>
    </div>
  );
}
