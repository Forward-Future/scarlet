import { WindowActions } from "../components/shell/WorkspaceNavigation";
import { PreferenceSelect } from "../components/ui/PreferenceSelect";
import { useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useNavigate, useParams } from "react-router-dom";
import type { Skill, SkillVersion, Task } from "@scarlet/shared";
import { useAgentAvailability } from "../components/agent/AgentChip";
import { api, errorMessage } from "../lib/client";
import { isComposing } from "../lib/hotkeys";
import { relTime } from "../lib/format";
import { composeSkill, slugify, splitFrontmatter, type SplitSkill } from "../lib/frontmatter";
import { useSkillsStore } from "../stores/skills";
import { useUiStore } from "../stores/ui";
import { ConfirmDialog, ErrorState, Icon, InlineError, Loading, Modal, Spinner, Toggle } from "../components/ui/primitives";
import { Said } from "../components/review/RunBundle";
// The conversation beside the skill is built from the pieces of a project's chat, and the page's plain text links are the chat's.
import "../simple.css";

const FINISHED = ["done", "failed", "cancelled"];

/** Unsaved edits as they are kept on this computer, with the version of the skill they were made on. */
interface Draft { name?: string; description?: string; body: string; enabled?: boolean; version?: number }
const isDraft = (draft: unknown): draft is Draft => !!draft && typeof (draft as Draft).body === "string";
function stored(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
function readDraft(key: string): Draft | null {
  const draft = stored(key);
  return isDraft(draft) ? draft : null;
}
/** The sets of edits that wait beside the page, the latest first. */
function readKept(key: string): Draft[] {
  const all = stored(key);
  return Array.isArray(all) ? all.filter(isDraft) : [];
}
function writeDraft(key: string, kept: Draft | Draft[] | null) {
  try {
    if (!kept || (Array.isArray(kept) && !kept.length)) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(kept));
  } catch { /* Storage is optional. */ }
}

/** What the page holds, as one string. A change is unsaved only while this differs from what was loaded or last saved. */
const pageOf = (name: string, description: string, body: string, enabled: boolean, original?: SplitSkill) =>
  JSON.stringify([name, enabled, composeSkill({ name: slugify(name) || name, description }, body, original)]);

export function SkillEditorPage({ onReturnToEdit }: { onReturnToEdit?: () => void } = {}) {
  const { skillId } = useParams();
  const isNew = !skillId;
  const navigate = useNavigate();
  const create = useSkillsStore((s) => s.create);
  const update = useSkillsStore((s) => s.update);
  const remove = useSkillsStore((s) => s.remove);

  const [loaded, setLoaded] = useState<{ skill: Skill; versions: SkillVersion[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [original, setOriginal] = useState<SplitSkill>();
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // What is wrong with the name, said beside the name.
  const [nameErr, setNameErr] = useState<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [viewVersion, setViewVersion] = useState<number | "current">("current");
  // Something on the page was changed since it was loaded or saved. It is unsaved unless the change was put back.
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(() => pageOf(name, description, body, enabled));
  const unsaved = dirty && pageOf(name, description, body, enabled, original) !== saved;
  // The page as it is this moment, for a save to tell whether it was typed in while the save was on its way.
  const pageNow = useRef("");
  pageNow.current = JSON.stringify([name, description, body, enabled]);
  // The conversation beside the skill: each change the editor asked for in words, and what came of it, in the order
  // asked. Scarlet saves each revision as a new version.
  const [edits, setEdits] = useState<Task[]>([]);
  const edit = edits.at(-1);
  const setEdit = (task: Task) => setEdits(all => all.some(t => t.id === task.id) ? all.map(t => t.id === task.id ? task : t) : [...all, task]);
  const thread = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const [ask, setAsk] = useState("");
  const [sending, setSending] = useState(false);
  const [askErr, setAskErr] = useState<string | null>(null);
  const { effective, unavailableReason } = useAgentAvailability();
  const working = !!edit && !FINISHED.includes(edit.state);
  const question = edit?.state === "waiting_for_user" ? edit.question : null;
  // The message box takes a new request only while the page shows the skill as saved, which is what Scarlet revises,
  // and none while Scarlet has one. An answer goes to the request that asked, whichever version shows.
  const boxOff = !question && (working || viewVersion !== "current");

  // Unsaved edits are kept on this computer until they are saved or discarded, so a quit doesn't lose them.
  const draftKey = `scarlet.skillDraft.v1/${skillId ?? "new"}`;
  // Edits made on an earlier version than the one saved now: the skill was saved again after they were made, as when
  // a rule is approved in Learnings. They aren't put back over what was saved. They wait under a key of their own, and
  // a line over the instructions offers them, until the editor brings them back or discards them. Nothing else lets
  // edits go: ones made meanwhile are kept beside them, and what is unsaved on the page when they are brought back
  // waits in their place, offered by the same line. So several sets can wait, the latest first, and the line offers the first.
  const keptKey = `${draftKey}/kept`;
  const [kept, setKept] = useState<Draft[]>([]);
  const keep = (waiting: Draft[]) => {
    writeDraft(keptKey, waiting);
    setKept(waiting);
  };
  const settle = () => {
    writeDraft(draftKey, null);
    setDirty(false);
  };
  const savedVersion = loaded?.skill.version;
  useEffect(() => {
    if (!dirty) return;
    // A change that was put back leaves nothing to keep.
    writeDraft(draftKey, unsaved ? { name, description, body, enabled, version: savedVersion } : null);
  }, [dirty, unsaved, name, description, body, enabled, draftKey, savedVersion]);
  const applyDraft = (draft: Draft) => {
    setNameErr(null);
    setName(draft.name ?? "");
    setDescription(draft.description ?? "");
    setBody(draft.body);
    setEnabled(draft.enabled !== false);
    setDirty(true);
  };
  /** Puts unsaved edits back on the page, unless the skill as saved (`saved`, its version) has moved past them. */
  const restoreDraft = (saved?: number) => {
    let draft = readDraft(draftKey);
    let waiting = saved === undefined ? [] : readKept(keptKey);
    if (draft && saved !== undefined && draft.version !== undefined && draft.version < saved) {
      waiting = [draft, ...waiting];
      writeDraft(keptKey, waiting);
      writeDraft(draftKey, null);
      draft = null;
    }
    setKept(waiting);
    if (draft) applyDraft(draft);
    return !!draft;
  };
  const bringBack = () => {
    const [back, ...rest] = kept;
    if (!back) return;
    // They go on the page in place of what is there. Unsaved, that is set aside in their place, so the line still has a way back to it.
    keep(unsaved ? [{ name, description, body, enabled, version: savedVersion }, ...rest] : rest);
    applyDraft(back);
    setViewVersion("current");
  };
  const discardKept = () => keep(kept.slice(1));

  // Esc goes back to the library like the back link, as it leaves Settings, unless a dialog, menu or text field is
  // using it. Leaving would ask about unsaved changes, so until they're saved Esc moves focus to Save instead. A
  // request typed in the message box and not sent would go with the page, unasked: until it's sent Esc moves to Send.
  const saveButton = useRef<HTMLButtonElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const typed = !!ask.trim();
  // The outline is for a focus the key put there, and focus set by script isn't always :focus-visible: the button is
  // marked until focus leaves it. A click on it shows no outline.
  const land = (button: HTMLButtonElement | null) => {
    if (!button) return;
    button.dataset.escFocus = "";
    button.addEventListener("blur", () => { delete button.dataset.escFocus; }, { once: true });
    button.focus();
    if (document.activeElement !== button) delete button.dataset.escFocus;
  };
  useEffect(() => {
    const leave = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (useUiStore.getState().shortcutsOpen || document.querySelector('dialog[open], [role="menu"]')) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) {
        target.blur();
        return;
      }
      e.preventDefault();
      if (unsaved) land(saveButton.current);
      else if (typed) land(sendButton.current);
      else navigate("/settings/skills");
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [navigate, unsaved, typed]);

  const leavingAfterSave = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    unsaved && !leavingAfterSave.current && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const show = (res: { skill: Skill; versions: SkillVersion[]; edits?: Task[] }) => {
    setLoaded(res);
    setEdits(res.edits ?? []);
    const parsed = splitFrontmatter(res.skill.content);
    setName(res.skill.name);
    const description = res.skill.description || parsed.frontmatter.description || "";
    setDescription(description);
    const original = { ...parsed, frontmatter: { ...parsed.frontmatter, name: res.skill.name, description } };
    setOriginal(original);
    setBody(parsed.body);
    setEnabled(res.skill.enabled);
    setSaved(pageOf(res.skill.name, description, parsed.body, res.skill.enabled, original));
    if (!restoreDraft(res.skill.version)) setDirty(false);
  };
  useEffect(() => {
    leavingAfterSave.current = false;
    // A failure belongs to the skill and the try it came from: another skill, or Retry, starts clean.
    setLoadError(null);
    if (isNew) return void restoreDraft();
    setLoaded(null);
    setEdits([]);
    setAsk("");
    setAskErr(null);
    let stale = false;
    api
      .skill(skillId)
      .then(res => { if (!stale) show(res); })
      .catch((e) => { if (!stale) setLoadError(errorMessage(e)); });
    return () => { stale = true; };
  }, [skillId, isNew, loadAttempt]);

  const content = useMemo(() => composeSkill({ name: slugify(name) || name, description }, body, original), [original, name, description, body]);
  const editorBody = viewVersion === "current" ? body : splitFrontmatter(loaded?.versions.find((v) => v.version === viewVersion)?.content ?? "").body;
  // The history lists each version once, newest first. The newest is the skill as it stands: it is the one marked
  // current, and only the ones before it can be restored. A skill with one version has nothing to go back to.
  const versionChoices = useMemo(() => {
    if (!loaded) return [];
    const line = (v: SkillVersion) => `v${v.version} · ${v.author?.name ?? "unknown"} · ${relTime(v.createdAt)}`;
    const newest = loaded.versions.find(v => v.version === loaded.skill.version);
    return [
      { value: "current" as const, label: `${newest ? line(newest) : `v${loaded.skill.version}`} · current` },
      ...loaded.versions.filter(v => v !== newest).reverse().map(v => ({ value: v.version, label: line(v) })),
    ];
  }, [loaded]);

  // The page isn't on the project's live feed, so it asks how the request is going. When it ends, the skill it
  // changed and its outcome arrive together.
  const editId = edit?.id;
  useEffect(() => {
    if (!working || !editId || !skillId) return;
    let gone = false;
    const timer = window.setInterval(() => {
      void api.task(editId, "conversation").then(async ({ task }) => {
        if (gone) return;
        if (!FINISHED.includes(task.state)) return setEdit(task);
        window.clearInterval(timer);
        const res = await api.skill(skillId).catch(() => null);
        if (gone) return;
        if (res) {
          show(res);
          useSkillsStore.getState().apply(res.skill);
          setViewVersion("current");
        }
        setEdit(task);
      }).catch(() => { /* The next ask tries again. */ });
    }, 1000);
    return () => { gone = true; window.clearInterval(timer); };
  }, [working, editId, skillId]);

  // The conversation opens at the latest and follows it.
  const latest = `${edits.length}/${edit?.state}`;
  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [latest, !!loaded]);

  const save = async (andLeave = false): Promise<boolean> => {
    const slug = slugify(name);
    if (!slug) {
      // Any name will do: it is saved as a slug. Only one with no letter or digit in it leaves nothing to save.
      // The name is what is wrong with this save, so why an earlier one failed leaves the page.
      setErr(null);
      setNameErr(name.trim() ? "Use letters a–z or digits in the name" : "Name the skill");
      nameField.current?.focus();
      return false;
    }
    setBusy(true);
    setErr(null);
    setNameErr(null);
    try {
      const payload = { name: slug, description, content, enabled };
      const sent = pageNow.current;
      if (isNew) {
        const s = await create(payload);
        leavingAfterSave.current = true;
        settle();
        if (!andLeave) {
          if (onReturnToEdit) onReturnToEdit();
          else navigate(`/settings/skills/${s.id}`, { replace: true });
        }
      } else {
        const s = await update(skillId, payload);
        setLoaded((l) => (l ? { ...l, skill: s } : l));
        const res = await api.skill(skillId);
        setLoaded(res);
        // The name is saved as a slug ("My Skill" as my-skill). The field shows what was saved, unless it was typed in since.
        setName(typed => (slugify(typed) === slug ? res.skill.name : typed));
        setSaved(pageOf(res.skill.name, description, body, enabled, original));
        // What was typed since Save was pressed wasn't sent: it stays unsaved, with its draft.
        if (pageNow.current === sent) settle();
        setViewVersion("current");
      }
      if (andLeave && blocker.state === "blocked") blocker.proceed();
      return true;
    } catch (e) {
      setErr(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const text = ask.trim();
    if (!text || sending || !skillId || boxOff) return;
    setAskErr(null);
    if (!question && !effective) return setAskErr(unavailableReason);
    setSending(true);
    try {
      if (question && edit) setEdit((await api.answerTask(edit.id, text)).task);
      else {
        // Scarlet revises the saved skill, so what's on the page is saved first.
        if (unsaved && !(await save())) return;
        setEdit((await api.editSkill(skillId, { prompt: text, ...effective! })).task);
      }
      setAsk("");
    } catch (e) {
      setAskErr(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const restore = (v: SkillVersion) => {
    const parsed = splitFrontmatter(v.content);
    setOriginal(parsed);
    setBody(parsed.body);
    if (parsed.frontmatter.description) setDescription(parsed.frontmatter.description);
    setViewVersion("current");
    setDirty(true);
  };

  // A skill that can't be read still has the way back to the library, and Retry reads it again without reloading the window.
  if (!isNew && loadError) return <div className="flex-1 min-h-0 flex flex-col">
    <div className="skill-editor-toolbar"><button className="btn-quiet" aria-keyshortcuts="Escape" title="Skill library (Esc)" onClick={() => navigate("/settings/skills")}>← Skill library</button></div>
    <ErrorState title="Couldn’t load skill" body={loadError} onRetry={() => setLoadAttempt(n => n + 1)} />
  </div>;
  if (!isNew && !loaded) return <Loading label="Loading skill…" />;

  const mark = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Marked while something is unsaved, as the Settings form is: Save then shows when Esc has put the keyboard on it. */}
      <div className="skill-editor-toolbar" data-unsaved={unsaved || undefined}>
        <button className="btn-quiet" data-close={onReturnToEdit ? "" : undefined} aria-keyshortcuts="Escape"
          title={onReturnToEdit ? "Back to edit (Esc)" : "Skill library (Esc)"} onClick={onReturnToEdit ?? (() => navigate("/settings/skills"))}>
          {onReturnToEdit ? "← Back to edit" : "← Skill library"}
        </button>
        {/* The name is edited where it reads. It is saved as a slug ("My Skill" as my-skill). */}
        <input id="sk-name" ref={nameField} className="skill-name" aria-label="Name" aria-invalid={nameErr ? true : undefined} value={name} disabled={working} placeholder="new-skill" spellCheck={false}
          style={{ width: `calc(${Math.max(name.length, 9) + 1}ch + 18px)` }} onChange={(e) => { setNameErr(null); mark(setName)(e.target.value); }} />
        {nameErr && <span role="alert" className="text-bad text-[12px]">{nameErr}</span>}
        {loaded && <span className="text-dim text-[11.5px]">v{loaded.skill.version}</span>}
        {unsaved && <span className="chip bg-warn/15 text-warn">Unsaved</span>}
        <div className="flex-1" />
        {versionChoices.length > 1 && (
          <PreferenceSelect compact label="Version history" value={viewVersion} onChange={setViewVersion} options={versionChoices}
            valueLabel={viewVersion === "current" ? "Current version" : undefined} />
        )}
        {viewVersion !== "current" && loaded && (
          <button className="btn-ghost" onClick={() => restore(loaded.versions.find((v) => v.version === viewVersion)!)}>
            Restore v{viewVersion}
          </button>
        )}
        {/* Delete is plain beside Save, and red only under the pointer: the dialog it opens is where the red is. */}
        {!isNew && (
          <button className="btn-quiet hover:text-bad" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
        <button ref={saveButton} className="btn-primary" onClick={() => void save()} disabled={busy || working || (!isNew && !unsaved)}>
          {busy && <Spinner className="size-3" />} {isNew ? "Create skill" : "Save"}
        </button>
        {/* The window's own status ends the row, as on the other pages. */}
        {!onReturnToEdit && <WindowActions inSettings />}
      </div>

      <div className="skill-editor-body">
        {!isNew && (
          <aside className="skill-chat" aria-label="Ask Scarlet to change this skill">
            {/* Each request reads as one does in a project's chat, from the same pieces: the editor's words in a band
                with where the request stands at its right, then Scarlet's lines under the band. */}
            <div className="simple-chat" ref={thread}>
              {edits.map(e => {
                const asking = e.state === "waiting_for_user", active = !FINISHED.includes(e.state);
                // A dot while Scarlet asks, a word once it stopped early, nothing once it's done. Stop follows while Scarlet has the request.
                const standing = asking ? <span className="unit-dot" aria-hidden /> : e.state === "cancelled" ? <span className="unit-word">Stopped</span>
                  : e.state === "failed" ? <span className="unit-word">Couldn’t finish</span> : null;
                return <div key={e.id} className="unit">
                  <div className="unit-msg" title={e.instruction}>
                    <span className="simple-who">You</span>
                    <p>{e.instruction}</p>
                    <span className="unit-state">{standing}</span>
                    {active && <button type="button" className="simple-link unit-stop"
                      onClick={() => void api.cancelTask(e.id).then(({ task }) => setEdit(task)).catch(err => setAskErr(errorMessage(err)))}>Stop</button>}
                  </div>
                  {asking ? <div className="req" data-state="asking"><div className="req-said">
                      <p className="req-say">{e.question}<button type="button" className="simple-link is-warn" onClick={() => box.current?.focus()}>Answer</button></p>
                    </div></div>
                    : active ? <div className="req" data-state="working" aria-busy><div className="req-row req-status"><span role="status" className="working-text">Revising the skill…</span></div></div>
                    : e.state === "done" ? <div className="req" data-state="done"><div className="req-said"><Said className="req-say" text={e.summary?.trim() || "Done."} /></div></div>
                    : e.state === "failed" && e.error ? <div className="req" data-state="failed"><div className="req-said"><p className="req-say is-note is-bad">{e.error}</p></div></div>
                    : null}
                </div>;
              })}
            </div>
            <div className="composer-dock">
              <InlineError>{askErr}</InlineError>
              <div className="composer-input">
                <div className="composer-box">
                  <div className="composer-row">
                    <div className="composer-message">
                      <span aria-hidden="true">{ask}{"\u200b"}</span>
                      <textarea ref={box} rows={1} className="placeholder:text-dim" value={ask} disabled={boxOff}
                        aria-label={question ? "Answer Scarlet" : "Tell Scarlet what to change in this skill"}
                        placeholder={question ? "Answer Scarlet…" : "Tell Scarlet what to change…"}
                        onChange={e => { setAsk(e.target.value); setAskErr(null); }}
                        onKeyDown={e => {
                          if (isComposing(e)) return;
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void send();
                          }
                          if (e.key === "Escape") e.currentTarget.blur();
                        }} />
                    </div>
                    {sending && <Spinner className="size-3.5 shrink-0" />}
                    {typed && <button ref={sendButton} type="button" className="btn-primary composer-send shrink-0" aria-label="Send" title="Send"
                      disabled={sending || (working && !question)} onClick={() => void send()}>
                      <Icon name="arrow" size={15} />
                    </button>}
                  </div>
                </div>
              </div>
            </div>
          </aside>
        )}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <div className="skill-details">
            {/* One line says what the field is and what it's for. It grows with what's written in it. */}
            <label className="eyebrow" htmlFor="sk-desc">When to use it</label>
            <div className="skill-enabled">
              <span>Enabled</span>
              <Toggle checked={enabled} onChange={mark(setEnabled)} label="Enabled" disabled={working} />
            </div>
            <div className="skill-when">
              <span className="field" aria-hidden="true">{description}{"\u200b"}</span>
              <textarea id="sk-desc" className="field" rows={1} value={description} disabled={working} onChange={(e) => mark(setDescription)(e.target.value)} />
            </div>
            <InlineError>{err}</InlineError>
          </div>
          <div className="skill-instructions-head">
            <span className="eyebrow">Instructions</span>
            {kept[0] && loaded && <span className="skill-kept" role="status">
              {/* Edits set aside when others were brought back were made on the version that is saved now. */}
              {kept[0].version === loaded.skill.version ? "You have unsaved changes set aside." : `You have unsaved changes from before v${loaded.skill.version}.`}
              <button type="button" className="simple-link" disabled={working} onClick={bringBack}>Bring them back</button>
              <button type="button" className="simple-link" onClick={discardKept}>Discard</button>
            </span>}
          </div>
          {isNew && <p id="skill-style-help" className="px-4 pt-3 text-[13px] leading-5 text-muted">
            A skill tells Scarlet how you like to edit your videos. Describe what to keep, cut, or change in your own words.
          </p>}
          <textarea
            className="flex-1 w-full bg-bg p-3 font-mono text-[12.5px] leading-5 resize-none max-md:min-h-[250px]"
            value={editorBody}
            aria-describedby={isNew ? "skill-style-help" : undefined}
            placeholder={isNew ? "For interviews, leave a beat after a difficult question." : undefined}
            readOnly={viewVersion !== "current" || working}
            onChange={(e) => mark(setBody)(e.target.value)}
            aria-label="Skill markdown"
            spellCheck={false}
          />
        </div>
      </div>

      <Modal open={blocker.state === "blocked"} onClose={() => { if (!busy) blocker.reset?.(); }} title="Save your skill changes?" footer={<>
        <button className="btn-ghost" disabled={busy} onClick={() => blocker.reset?.()}>Stay</button>
        <button className="btn-ghost" disabled={busy} onClick={() => { settle(); blocker.proceed?.(); }}>Discard changes</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save(true)}>Save and leave</button>
      </>}>
        <p>Your skill has unsaved changes.</p>
        <InlineError>{nameErr ?? err}</InlineError>
      </Modal>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete skill “${loaded?.skill.name}”?`}
        body="Scarlet stops using it immediately. Version history is removed."
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          if (!skillId) return;
          await remove(skillId);
          leavingAfterSave.current = true;
          settle();
          writeDraft(keptKey, null);
          navigate("/settings/skills");
        }}
      />
    </div>
  );
}
