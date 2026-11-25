import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { slugifyStyleGuideName, type StyleGuideAsset, type StyleGuideRecord, type Task, type TaskEvent } from "@scarlet/shared";
import { AgentChip, useAgentAvailability } from "../components/agent/AgentChip";
import { SkillCommandInput } from "../components/agent/SkillCommandInput";
import { Said } from "../components/review/RunBundle";
import { WindowActions } from "../components/shell/WorkspaceNavigation";
import { ConfirmDialog, ErrorState, Icon, InlineError, Loading, Modal, Spinner, Toggle } from "../components/ui/primitives";
import { api, errorMessage } from "../lib/client";
import { desktop, isDesktop } from "../lib/desktop";
import { isComposing } from "../lib/hotkeys";
import { taskActivityLabel } from "../lib/taskActivity";
import { isActiveTask } from "../lib/taskRun";
import { useEscapeToLeave, useFileDropTarget } from "../lib/uiHooks";
import { useStyleGuidesStore } from "../stores/styleGuides";
import { useUiStore } from "../stores/ui";
import "../simple.css";

interface StagedFile {
  key: string;
  name: string;
  source: File | { path: string };
}

function uniqueSlug(base: string, existing: readonly StyleGuideRecord[]): string {
  const taken = new Set(existing.map(g => g.name.toLowerCase()));
  const root = slugifyStyleGuideName(base) || "style-guide";
  if (!taken.has(root)) return root;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${root}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${root}-${Date.now()}`;
}

export function StyleGuideEditorPage() {
  const styleGuidesBeta = useUiStore(s => s.styleGuidesBeta);
  const { styleGuideId } = useParams();
  const isNew = !styleGuideId;
  const navigate = useNavigate();

  const library = useStyleGuidesStore(s => s.styleGuides);
  const storeGuide = useStyleGuidesStore(s => (styleGuideId ? s.styleGuides.find(g => g.id === styleGuideId) : undefined));
  const loadLibrary = useStyleGuidesStore(s => s.load);
  const create = useStyleGuidesStore(s => s.create);
  const update = useStyleGuidesStore(s => s.update);
  const remove = useStyleGuidesStore(s => s.remove);

  const [loaded, setLoaded] = useState<StyleGuideRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Merge live store updates (e.g. preview updated via WebSocket) with loaded record.
  const guide = useMemo(() => {
    if (isNew) return null;
    if (storeGuide && loaded) {
      return (storeGuide.updatedAt ?? "") >= (loaded.updatedAt ?? "") ? storeGuide : loaded;
    }
    return storeGuide ?? loaded;
  }, [isNew, storeGuide, loaded]);

  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const [edits, setEdits] = useState<Task[]>([]);
  const [activeEvents, setActiveEvents] = useState<TaskEvent[]>([]);
  const edit = edits.at(-1);
  const setEdit = (task: Task) =>
    setEdits(all => (all.some(t => t.id === task.id) ? all.map(t => (t.id === task.id ? task : t)) : [...all, task]));

  const [ask, setAsk] = useState("");
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [sending, setSending] = useState(false);
  const [askErr, setAskErr] = useState<string | null>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const askId = useId();
  const { effective, unavailableReason } = useAgentAvailability();

  const working = !!edit && isActiveTask(edit.state);
  const question = edit?.state === "waiting_for_user" ? edit.question : null;
  const boxOff = !question && working;

  useEffect(() => {
    if (useStyleGuidesStore.getState().status === "idle") void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    setLoadError(null);
    if (isNew) {
      setLoaded(null);
      setEdits([]);
      setActiveEvents([]);
      setName("");
      setIsDefault(false);
      setNameErr(null);
      setAskErr(null);
      return;
    }
    setLoaded(null);
    setEdits([]);
    setActiveEvents([]);
    setNameErr(null);
    setAskErr(null);
    let stale = false;
    api.styleGuide(styleGuideId)
      .then(res => {
        if (stale) return;
        setLoaded(res.styleGuide);
        setName(res.styleGuide.name);
        setIsDefault(res.styleGuide.isDefault);
        setEdits(res.edits ?? []);
        useStyleGuidesStore.getState().apply(res.styleGuide);
      })
      .catch(err => { if (!stale) setLoadError(errorMessage(err)); });
    return () => { stale = true; };
  }, [styleGuideId, isNew, loadAttempt]);

  // Keep toolbar default state synchronized if another style guide took default via WS.
  useEffect(() => {
    if (guide) setIsDefault(guide.isDefault);
  }, [guide?.isDefault]);

  // Poll active style_guide_edit task and refresh guide + preview live as soon as Scarlet finishes.
  const editId = edit?.id;
  useEffect(() => {
    if (!working || !editId || !styleGuideId) return;
    let gone = false;
    const timer = window.setInterval(() => {
      void api.task(editId, "all").then(async ({ task, events }) => {
        if (gone) return;
        setActiveEvents(events);
        if (isActiveTask(task.state)) {
          setEdit(task);
          return;
        }
        const refreshed = await api.styleGuide(styleGuideId).catch(() => null);
        if (gone) return;
        if (refreshed) {
          setLoaded(refreshed.styleGuide);
          useStyleGuidesStore.getState().apply(refreshed.styleGuide);
          setEdits(refreshed.edits ?? []);
        } else {
          setEdit(task);
        }
        setActiveEvents([]);
        window.clearInterval(timer);
      }).catch(() => { /* Retry on next tick. */ });
    }, 1000);
    return () => { gone = true; window.clearInterval(timer); };
  }, [working, editId, styleGuideId]);

  // Keep chat scrolled to the newest message.
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [edits.length, edit?.state, activeEvents.length]);

  useEscapeToLeave(() => {
    if (lightboxOpen) { setLightboxOpen(false); return; }
    navigate("/settings/style-guides");
  }, 'dialog[open], [role="menu"], [data-shortcut-overlay]');

  const stageItems = (items: Array<File | { path: string }>) => {
    setStagedFiles(prev => [
      ...prev,
      ...items.map(source => ({
        key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: source instanceof File ? source.name : source.path.split(/[\\/]/).pop() || "file",
        source,
      })),
    ]);
  };

  const { over: dropping, dropProps } = useFileDropTarget(
    paths => stageItems(paths.map(path => ({ path }))),
    files => stageItems(Array.from(files)),
    { ignoreChildLeave: true },
  );

  const pickFiles = async () => {
    if (isDesktop()) {
      const picked = await desktop.pickFile("Attach a logo, font, or reference image").catch(() => null);
      if (picked) stageItems([{ path: picked }]);
      return;
    }
    fileInputRef.current?.click();
  };

  const commitName = async () => {
    if (isNew || !guide) return;
    const slug = slugifyStyleGuideName(name);
    if (!slug) {
      setNameErr("Use letters or numbers");
      return;
    }
    if (slug === guide.name) {
      setName(slug);
      setNameErr(null);
      return;
    }
    setSavingMeta(true);
    setNameErr(null);
    try {
      const saved = await update(guide.id, { name: slug });
      setLoaded(saved);
      setName(saved.name);
    } catch (e) {
      setNameErr(errorMessage(e));
    } finally {
      setSavingMeta(false);
    }
  };

  const toggleDefault = async (checked: boolean) => {
    if (isNew || !guide) {
      setIsDefault(checked);
      return;
    }
    setIsDefault(checked);
    setSavingMeta(true);
    try {
      const saved = await update(guide.id, { isDefault: checked });
      setLoaded(saved);
    } catch (e) {
      setIsDefault(guide.isDefault);
      setAskErr(errorMessage(e));
    } finally {
      setSavingMeta(false);
    }
  };

  const send = async (overrideText?: string) => {
    const text = (overrideText ?? ask).trim();
    if (!text || sending || boxOff) return;
    setAskErr(null);
    if (!question && !effective) {
      setAskErr(unavailableReason);
      return;
    }
    setSending(true);
    try {
      let targetGuide = guide;
      if (!targetGuide) {
        const requestedSlug = slugifyStyleGuideName(name);
        const derived = requestedSlug || uniqueSlug(text.split(/\s+/).slice(0, 3).join("-"), library);
        targetGuide = await create({ name: derived, isDefault });
        setLoaded(targetGuide);
        setName(targetGuide.name);
      }

      const uploaded: StyleGuideAsset[] = [];
      for (const item of stagedFiles) {
        const res = await api.uploadStyleGuideAsset(targetGuide.id, item.source, item.name);
        uploaded.push(res.asset);
        targetGuide = res.styleGuide;
        setLoaded(res.styleGuide);
        useStyleGuidesStore.getState().apply(res.styleGuide);
      }

      const attachments = uploaded.length
        ? uploaded.map(({ id, name: fileName, size, mime }) => ({ id, name: fileName, size, ...(mime && { mime }) }))
        : undefined;

      if (question && edit) {
        const answered = await api.answerTask(
          edit.id,
          text,
          undefined,
          undefined,
          attachments ? { attachments } : undefined,
        );
        setEdit(answered.task);
      } else {
        const started = await api.editStyleGuide(targetGuide.id, {
          prompt: text,
          ...(attachments && { attachments }),
          ...effective!,
        });
        setEdit(started.task);
      }

      setAsk("");
      setStagedFiles([]);
      if (isNew) {
        navigate(`/settings/style-guides/${targetGuide.id}`, { replace: true });
      }
    } catch (e) {
      setAskErr(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const liveActivity = useMemo(() => {
    for (let i = activeEvents.length - 1; i >= 0; i--) {
      const label = taskActivityLabel(activeEvents[i]!);
      if (label) return `${label}…`;
    }
    return "Updating the style guide…";
  }, [activeEvents]);

  if (!styleGuidesBeta) return <Navigate replace to="/settings" />;
  if (!isNew && loadError) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="skill-editor-toolbar">
          <button className="btn-quiet" aria-keyshortcuts="Escape" title="Style guides (Esc)" onClick={() => navigate("/settings/style-guides")}>
            ← Style guides
          </button>
        </div>
        <ErrorState title="Couldn’t load style guide" body={loadError} onRetry={() => setLoadAttempt(n => n + 1)} />
      </div>
    );
  }
  if (!isNew && !guide) return <Loading label="Loading style guide…" />;

  const previewUrl = guide?.preview ? api.styleGuidePreviewUrl(guide.id, guide.preview.updatedAt) : undefined;
  const typed = !!ask.trim();

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="skill-editor-toolbar">
        <button className="btn-quiet" aria-keyshortcuts="Escape" title="Style guides (Esc)" onClick={() => navigate("/settings/style-guides")}>
          ← Style guides
        </button>
        <span className="style-guide-name-wrap">
          <span className="text-dim font-mono text-[13px]" aria-hidden="true">@</span>
          <input
            id="sg-name"
            className="skill-name"
            aria-label="Style guide name"
            aria-invalid={nameErr ? true : undefined}
            value={name}
            disabled={working || savingMeta}
            placeholder="my-style"
            spellCheck={false}
            style={{ width: `calc(${Math.max(name.length, 9) + 1}ch + 16px)` }}
            onChange={e => { setNameErr(null); setName(e.target.value); }}
            onBlur={() => void commitName()}
            onKeyDown={e => {
              if (isComposing(e)) return;
              if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
            }}
          />
        </span>
        {nameErr && <span role="alert" className="text-bad text-[12px]">{nameErr}</span>}
        <label className="skill-enabled ml-2 cursor-pointer">
          <span>Default</span>
          <Toggle checked={isDefault} onChange={checked => void toggleDefault(checked)} label="Use as default style guide" disabled={working || savingMeta} />
        </label>
        <div className="flex-1" />
        <AgentChip direction="down" variant="icon" />
        {!isNew && (
          <button
            type="button"
            className="btn-quiet hover:text-bad"
            disabled={working}
            title={working ? "Wait for Scarlet to finish updating this style guide." : undefined}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </button>
        )}
        <WindowActions inSettings />
      </div>

      <div className="skill-editor-body">
        <aside className="skill-chat" aria-label="Style guide chat">
          <div className="simple-chat" ref={threadRef}>
            {edits.length === 0 && (
              <div className="style-guide-chat-empty">
                <p>Describe the look you want, or drop a logo, font, or reference screenshot into the message box.</p>
                <p className="text-dim mt-2 text-[12px]">
                  Scarlet will render a live 16:9 preview beside you and apply this style whenever you create graphics.
                </p>
              </div>
            )}
            {edits.map(e => {
              const asking = e.state === "waiting_for_user";
              const active = isActiveTask(e.state);
              const standing = asking
                ? <span className="unit-dot" aria-hidden />
                : e.state === "cancelled"
                  ? <span className="unit-word">Stopped</span>
                  : e.state === "failed"
                    ? <span className="unit-word">Couldn’t finish</span>
                    : null;
              const files = e.context.attachments ?? [];
              return (
                <div key={e.id} className="unit">
                  <div className="unit-msg">
                    <span className="simple-who">You</span>
                    <div className="min-w-0 flex-1">
                      <Said text={e.instruction}>{e.instruction}</Said>
                      {files.length > 0 && (
                        <div className="style-guide-msg-files">
                          {files.map(f => (
                            <span key={f.id} className="style-guide-msg-file">
                              <Icon name="file" size={11} /> {f.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <span className="unit-state">{standing}</span>
                    {active && (
                      <button
                        type="button"
                        className="simple-link unit-stop"
                        onClick={() => void api.cancelTask(e.id).then(({ task }) => setEdit(task)).catch(err => setAskErr(errorMessage(err)))}
                      >
                        Stop
                      </button>
                    )}
                  </div>
                  {asking ? (
                    <div className="req" data-state="asking">
                      <div className="req-said">
                        <p className="req-say">
                          {e.question}
                          <button type="button" className="simple-link is-warn" onClick={() => boxRef.current?.focus()}>Answer</button>
                        </p>
                        {e.questionChoices && e.questionChoices.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {e.questionChoices.map(choice => (
                              <button key={choice} type="button" className="btn-ghost text-[12px] py-1 px-2.5" onClick={() => void send(choice)}>
                                {choice}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : active ? (
                    <div className="req" data-state="working" aria-busy>
                      <div className="req-row req-status">
                        <span role="status" className="working-text">{liveActivity}</span>
                      </div>
                    </div>
                  ) : e.state === "done" ? (
                    <div className="req" data-state="done">
                      <div className="req-said">
                        <Said className="req-say" text={e.summary?.trim() || "Updated preview."}>{e.summary?.trim() || "Updated preview."}</Said>
                      </div>
                    </div>
                  ) : e.state === "failed" && e.error ? (
                    <div className="req" data-state="failed">
                      <div className="req-said">
                        <p className="req-say is-note is-bad">{e.error}</p>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div {...dropProps} className="composer-dock">
            <InlineError>{askErr}</InlineError>
            <div className="composer-input">
              {stagedFiles.length > 0 && (
                <div className="composer-files" role="group" aria-label="Files attached to your message">
                  {stagedFiles.map(file => (
                    <div key={file.key} className="composer-file is-ready" title={file.name}>
                      <span className="composer-file-icon"><Icon name="file" size={12} /></span>
                      <span className="composer-file-name">{file.name}</span>
                      <button
                        type="button"
                        className="composer-file-remove"
                        aria-label={`Remove ${file.name}`}
                        title="Remove"
                        onClick={() => setStagedFiles(prev => prev.filter(f => f.key !== file.key))}
                      >
                        <Icon name="x" size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div
                className="composer-box"
                onPaste={e => {
                  const files = Array.from(e.clipboardData?.files ?? []);
                  if (!files.length) return;
                  e.preventDefault();
                  stageItems(files);
                }}
              >
                <div className="composer-row">
                  <button
                    type="button"
                    className="btn-icon shrink-0 text-muted hover:text-fg"
                    aria-label="Attach logo, font, or screenshot"
                    title="Attach logo, font, or screenshot"
                    disabled={boxOff || sending}
                    onClick={() => void pickFiles()}
                  >
                    <Icon name="paperclip" size={14} />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="sr-only"
                    onChange={e => {
                      const files = Array.from(e.target.files ?? []);
                      if (files.length) stageItems(files);
                      e.target.value = "";
                    }}
                  />
                  <SkillCommandInput
                    inputRef={boxRef}
                    value={ask}
                    skills={[]}
                    plain
                    id={askId}
                    disabled={boxOff}
                    ariaLabel={question ? "Answer Scarlet" : "Describe your style or drop a logo, font, or screenshot"}
                    placeholder={question ? "Answer Scarlet…" : "Describe a look, or drop a logo, font, or screenshot…"}
                    onChange={text => { setAsk(text); setAskErr(null); }}
                    onSubmit={() => void send()}
                  />
                  {sending && <Spinner className="size-3.5 shrink-0" />}
                  {typed && (
                    <button
                      type="button"
                      className="btn-primary composer-send shrink-0"
                      aria-label="Send"
                      title="Send"
                      disabled={sending || boxOff}
                      onClick={() => void send()}
                    >
                      <Icon name="arrow" size={15} />
                    </button>
                  )}
                </div>
              </div>
            </div>
            {dropping && <div className="composer-drop" aria-hidden="true">Attach to your message</div>}
          </div>
        </aside>

        <main className="style-guide-preview-pane" aria-label="Style guide preview">
          <div className="style-guide-preview-stage">
            {previewUrl ? (
              <button
                type="button"
                className="style-guide-preview-frame is-clickable"
                onClick={() => setLightboxOpen(true)}
                title="Click to inspect full size"
              >
                <img src={previewUrl} alt={`Live preview of @${guide!.name}`} />
              </button>
            ) : (
              <div className="style-guide-preview-frame is-empty">
                <span className="style-guide-preview-placeholder-title">Live preview</span>
                <span className="style-guide-preview-placeholder-body">
                  Describe the look you want or drop a logo, font, or screenshot in chat.
                </span>
              </div>
            )}
            {working && (
              <div className="style-guide-preview-status" role="status">
                <Spinner className="size-3" />
                <span>{liveActivity}</span>
              </div>
            )}
            {!working && guide?.description && (
              <p className="style-guide-preview-caption">{guide.description}</p>
            )}
          </div>
        </main>
      </div>

      <Modal open={lightboxOpen && !!previewUrl} onClose={() => setLightboxOpen(false)} title={`@${guide?.name ?? ""}`} width={1080}>
        {previewUrl && (
          <div className="style-guide-lightbox">
            <img src={previewUrl} alt={`Full size preview of @${guide?.name}`} />
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete style guide “@${guide?.name}”?`}
        body="Scarlet will stop using this style guide and remove its attached files and preview."
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          if (!guide) return;
          await remove(guide.id);
          navigate("/settings/style-guides");
        }}
      />
    </div>
  );
}
