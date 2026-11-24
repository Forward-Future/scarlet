import { useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { errorMessage, IS_DESKTOP } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { matchFirstClip } from "../../lib/firstClipFormat";
import { isComposing } from "../../lib/hotkeys";
import { ACCEPTED_MEDIA } from "../../lib/upload";
import { useProjectStore } from "../../stores/project";
import { enqueueImports, filename, type ImportSource } from "../../components/media/UploadDropzone";
import { useFileDropTarget } from "../../lib/uiHooks";
import { useAgentAvailability } from "../../components/agent/AgentChip";
import { Icon, InlineError, Spinner } from "../../components/ui/primitives";

/** What a project Scarlet starts is called until Scarlet names it from the footage or the editor's words. */
export const NEW_PROJECT_NAME = "New project";
/** What the message says when the editor sends files with no words. */
const FILES_ONLY = "Start a project with these files.";

const sourceKey = (source: ImportSource) => typeof source === "string" ? source : `${source.name}\0${source.size}\0${source.lastModified}`;

/**
 * A message box on the library that starts a project: the editor says where their footage is ("my videos are in
 * ~/Movies/Shoot") or drops it on the box, with anything else they want, and Scarlet makes the project, adds the
 * footage and carries on in the new project's chat, which opens.
 */
export function StartProject() {
  const navigate = useNavigate();
  const createProject = useProjectStore(s => s.createProject);
  const createTask = useProjectStore(s => s.createTask);
  const deleteProject = useProjectStore(s => s.deleteProject);
  const { effective, unavailableReason } = useAgentAvailability();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<ImportSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const attach = (sources: ImportSource[]) => {
    if (busy || !sources.length) return;
    setError("");
    setFiles(was => {
      const has = new Set(was.map(sourceKey));
      return [...was, ...sources.filter(source => !has.has(sourceKey(source)))];
    });
    input.current?.focus();
  };
  // Files dropped on the box go with the message. Dropped anywhere else on Projects, they start a project as before.
  const { over, dropProps } = useFileDropTarget(attach, list => attach(Array.from(list)));

  const pick = async () => {
    if (!IS_DESKTOP) {
      fileInput.current?.click();
      return;
    }
    try {
      attach(await desktop.pickFiles());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const send = async () => {
    const words = text.trim();
    if (busy || (!words && !files.length)) return;
    if (!effective) {
      setError(unavailableReason);
      return;
    }
    setBusy(true);
    setError("");
    let made: string | undefined;
    try {
      const project = await createProject({ name: NEW_PROJECT_NAME });
      made = project.id;
      // Files from this computer go to Scarlet by where they are, as a folder named in the words does. A file the
      // window has only as its contents is added first, so it's in the project when Scarlet looks.
      const paths = files.filter((f): f is string => typeof f === "string");
      const uploads = files.filter((f): f is File => typeof f !== "string");
      if (uploads.length) await enqueueImports(project.id, uploads, matchFirstClip(project));
      const said = words || FILES_ONLY;
      const instruction = paths.length ? `${said}\n\nFiles the editor gave with this message:\n${paths.map(p => `- ${p}`).join("\n")}` : said;
      await createTask(project.id, { kind: "edit", ...effective, instruction,
        context: { ...(project.head && { version: project.head }), ...(instruction !== said && { message: said }) } });
      made = undefined;
      setText("");
      setFiles([]);
      navigate(`/p/${project.id}`);
    } catch (e) {
      setError(errorMessage(e));
      // A project that never got its request is taken back, so a failed send leaves nothing behind but the words.
      if (made) await deleteProject(made).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const ready = !!(text.trim() || files.length);
  return (
    <div {...dropProps} className="library-start composer-input">
      <label htmlFor={inputId} className="sr-only">Start a project with Scarlet</label>
      {files.length > 0 && <div className="composer-files" role="group" aria-label="Files for the new project">
        {files.map(file => <div key={sourceKey(file)} className="composer-file" title={typeof file === "string" ? file : file.name}>
          <span className="composer-file-icon"><Icon name="file" size={12} /></span>
          <span className="composer-file-name">{filename(file)}</span>
          <button type="button" className="composer-file-remove" aria-label={`Remove ${filename(file)}`} title="Remove" disabled={busy}
            onClick={() => { setFiles(was => was.filter(f => sourceKey(f) !== sourceKey(file))); input.current?.focus(); }}><Icon name="x" size={11} /></button>
        </div>)}
      </div>}
      <div className="composer-box">
        <div className="composer-row">
          <input ref={fileInput} type="file" hidden multiple accept={ACCEPTED_MEDIA} onChange={e => {
            if (e.target.files) attach(Array.from(e.target.files));
            e.target.value = "";
          }} />
          <button type="button" className="btn-icon library-start-add" aria-label="Add videos" title="Add videos" disabled={busy} onClick={() => void pick()}>
            <Icon name="plus" size={15} />
          </button>
          <div className="composer-message">
            <span aria-hidden="true">{text || " "}</span>
            <textarea id={inputId} ref={input} rows={1} className="placeholder:text-dim" value={text} disabled={busy}
              placeholder="Start a project: say where your videos are, or drop them here"
              onChange={e => { setText(e.target.value); setError(""); }}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey && !isComposing(e)) {
                  e.preventDefault();
                  void send();
                }
              }} />
          </div>
          {busy && <Spinner className="size-3.5 shrink-0" />}
          {ready && <button type="button" className="btn-primary composer-send shrink-0" aria-label="Start project" title="Start project" disabled={busy}
            onClick={() => void send()}><Icon name="arrow" size={15} /></button>}
        </div>
      </div>
      <InlineError>{error}</InlineError>
      {over && <div className="library-start-drop" aria-hidden="true">Add to your new project</div>}
    </div>
  );
}
