import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { errorMessage, IS_DESKTOP } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { matchFirstClip } from "../../lib/firstClipFormat";
import { ACCEPTED_MEDIA, MEDIA_FORMAT_HINT } from "../../lib/upload";
import { useProjectStore } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import { Dropzone, enqueueImports, filename, type ImportSource } from "../../components/media/UploadDropzone";
import { Field, Icon, InlineError, Modal, Spinner } from "../../components/ui/primitives";

/** Quick start. While no model is ready its first step is signing in, and `onSignIn` brings back the sign-in screen. */
export function FirstEditGuide({ onSignIn }: { onSignIn?: () => void }) {
  return (
    <>
      <ol className="first-edit-steps">
        {onSignIn && <li>
          <h3>Sign in to a model</h3>
          <p>Scarlet uses your own Claude, ChatGPT or Google plan. <button type="button" className="first-edit-link" onClick={onSignIn}>Sign in</button></p>
        </li>}
        <li>
          <h3>Add your footage</h3>
          <p>Drop a clip onto Projects or choose <strong>New project</strong>.</p>
        </li>
        <li>
          <h3>Ask for an edit</h3>
          <p>Close Media, then type or say “Trim the silence before my first word.”</p>
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

/** One file chosen twice is listed once: a path is itself, a browser file its name, size and date. */
const sourceKey = (source: ImportSource) => typeof source === "string" ? source : `${source.name}:${source.size}:${source.lastModified}`;
/** A project is named for its first video until the editor names it. */
const nameFrom = (sources: ImportSource[]) => filename(sources[0]!).replace(/\.[^.]+$/, "") || "Untitled project";

export function NewProjectModal({ initialFiles, empty, notice, local, onClose }: {
  initialFiles: ImportSource[]; empty: boolean; notice: string; local?: boolean; onClose(): void;
}) {
  const createProject = useProjectStore((s) => s.createProject);
  const navigate = useNavigate();
  const initialName = initialFiles.length ? nameFrom(initialFiles) : "";
  const [name, setName] = useState(initialName);
  const [files, setFiles] = useState<ImportSource[]>(initialFiles);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // The name the first video last gave, so another selection renames a project the editor hasn't named themselves.
  const given = useRef(initialName);

  const selectFootage = (sources: ImportSource[]) => {
    setFiles(sources);
    // Videos chosen in the dialog name the project as videos dropped on the library do. A name the editor typed stays.
    const was = given.current, next = sources.length ? nameFrom(sources) : "";
    given.current = next;
    setName(typed => !typed.trim() || typed === was ? next : typed);
  };

  /** Videos chosen or dropped on the open dialog join the ones already there, once each. */
  const addFootage = (sources: ImportSource[]) => {
    if (busy || !sources.length) return;
    const has = new Set(files.map(sourceKey));
    selectFootage([...files, ...sources.filter(source => !has.has(sourceKey(source)))]);
  };

  const removeFootage = (index: number) => {
    if (!busy) selectFootage(files.filter((_, at) => at !== index));
  };

  const pick = async () => {
    if (!IS_DESKTOP) {
      fileInput.current?.click();
      return;
    }
    setErr(null);
    try {
      addFootage(await desktop.pickFiles());
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

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose(); }}
      title="New project"
      footer={
        <>
          <button className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
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
            <legend className="label">Media files</legend>
            <input ref={fileInput} type="file" hidden multiple accept={ACCEPTED_MEDIA} onChange={e => {
              if (e.target.files) addFootage(Array.from(e.target.files));
              e.target.value = "";
            }} />
            <button type="button" className="btn-ghost" aria-describedby="np-file-types" disabled={busy} onClick={() => void pick()}>
              {files.length ? "Add files…" : "Choose files…"}
            </button>
            {/* Each file has its own ×: Clear is for a longer list. */}
            {files.length > 1 && <button type="button" className="btn-quiet" disabled={busy} onClick={() => selectFootage([])}>Clear</button>}
            <p id="np-file-types" className="sr-only">{MEDIA_FORMAT_HINT}</p>
          </fieldset>
          {files.length > 0 && <>
            <ul aria-label="Selected files" className="new-project-files">
              {files.map((file, index) => <li key={sourceKey(file)}>
                <span>{filename(file)}</span>
                <button type="button" className="new-project-file-remove" aria-label={`Remove ${filename(file)}`} title="Remove" disabled={busy}
                  onClick={() => removeFootage(index)}><Icon name="x" size={11} /></button>
              </li>)}
            </ul>
            {/* Said only when audio leaves this computer or can't be transcribed: local transcription is the quiet default. */}
            {notice && !local && <p className="mt-2 text-[12px] text-muted">{notice}</p>}
          </>}
          <InlineError>{err}</InlineError>
        </Dropzone>
      </form>
    </Modal>
  );
}
