import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Learning } from "@scarlet/shared";
import { errorMessage } from "../../lib/client";
import { useProjectStore } from "../../stores/project";
import { useSkillsStore } from "../../stores/skills";
import { useAgentAvailability } from "../agent/AgentChip";
import { Icon } from "../ui/primitives";
import { PreferenceSelect } from "../ui/PreferenceSelect";

/** The learnings that still wait: on the editor's call, or on Scarlet while it saves one they approved. */
export function openLearnings(learnings: Learning[] | undefined): Learning[] {
  return (learnings ?? []).filter(l => l.state === "suggested" || l.state === "saving");
}

/** The ones that wait on the editor. The simple view marks its menu while there are any. */
export function learningsToReview(learnings: Learning[] | undefined): number {
  return (learnings ?? []).filter(l => l.state === "suggested").length;
}

/** Quotes in a sentence: “a”, “b” and “c”. */
function quoted(passages: string[]): string {
  const marked = passages.map(p => `“${p}”`);
  return marked.length > 1 ? `${marked.slice(0, -1).join(", ")} and ${marked.at(-1)}` : marked[0] ?? "";
}

/**
 * Learnings: rules Scarlet picked up from what the editor asked for, each waiting for their call. A rule reads as it
 * would in the skill, with the words it came from under it, and what the skill already says that it would replace.
 * The editor picks the skill, Revise lets them reword the rule in place, then Approve has Scarlet revise that skill
 * around it and × declines it. Nothing is saved without Approve. The list opens under the header from the menu and
 * closes on Esc or a press outside it.
 */
export function LearningsPanel({ onClose }: { onClose(): void }) {
  const learnings = useProjectStore(s => s.current?.learnings);
  const list = openLearnings(learnings);
  const panel = useRef<HTMLDivElement>(null);
  const loadSkills = useSkillsStore(s => s.load);
  // With no skills read, no rule has one to pick and none can be approved. That says why, with the way to ask again.
  const skillsError = useSkillsStore(s => s.status === "error" && !s.skills.length ? s.error ?? "" : null);
  // The skills are asked for as the panel opens, unless they're already in. A read that failed earlier, while the
  // engine restarted, is tried again then: without them no rule has a skill to pick, or an Approve that works. It is
  // asked once per opening whatever comes back, so a read that keeps failing isn't asked over and over.
  useEffect(() => { if (useSkillsStore.getState().status !== "ready") void loadSkills(); }, [loadSkills]);

  // The page hands over a new onClose each time it draws, which it does all the while Scarlet works or a file
  // transcribes or caches. The listeners read the latest one, so the panel takes the keyboard only as it opens: taken
  // again on each redraw, it would shut a skill list that's open and pull the keyboard off Approve.
  const close = useRef(onClose);
  close.current = onClose;
  // A rule being reworded takes Esc first: it puts the rule back as it was, and the list stays open.
  const rewording = useRef<(() => void) | null>(null);
  useEffect(() => {
    panel.current?.focus();
    // The skill picker's list is drawn outside the panel, over the page. A press in it is a press in the panel.
    const press = (e: PointerEvent) => {
      const at = e.target as Element | null;
      if (!panel.current?.contains(at) && !at?.closest?.('[role="listbox"]')) close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector('[role="listbox"]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (rewording.current) rewording.current();
      else close.current();
    };
    document.addEventListener("pointerdown", press);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", press);
      window.removeEventListener("keydown", key, true);
    };
  }, []);

  return <div ref={panel} className="learn-panel" role="dialog" aria-label="Learnings" tabIndex={-1} data-shortcut-overlay>
    <h2 className="learn-title">Learnings</h2>
    {list.length > 0 && skillsError !== null && <p className="learn-problem" role="alert">Couldn’t load skills.{skillsError && ` ${skillsError}`}{" "}
      <button type="button" className="simple-link" onClick={() => void loadSkills()}>Retry</button></p>}
    {list.length ? <ol className="learn-list">{list.map(l => <LearningRow key={l.id} learning={l} rewording={rewording} />)}</ol>
      : <div className="learn-empty"><p>Nothing to learn yet.</p>
        <p>When something you ask for reads like a rule, it waits here for you to approve.</p></div>}
  </div>;
}

function LearningRow({ learning, rewording }: { learning: Learning; rewording: { current: (() => void) | null } }) {
  const skills = useSkillsStore(s => s.skills);
  const [skillId, setSkillId] = useState(learning.skillId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = learning.state === "saving";
  // The rule is saved by the model chosen now, not the one the request it came from ran on.
  const { effective } = useAgentAvailability();
  // Skills are listed by name, as they are everywhere else. The suggested one stays on offer even if it was switched off since.
  const options = skills.filter(s => s.enabled || s.id === learning.skillId).sort((a, b) => a.name.localeCompare(b.name))
    .map(s => ({ value: s.id, label: s.name }));
  const chosen = options.some(o => o.value === skillId) ? skillId : learning.skillId;

  // Revise turns the rule into a line the editor rewords in place. Enter or a press elsewhere keeps the new wording,
  // Esc puts it back. The new wording shows at once and is saved behind it; Approve and × wait for that save, so the
  // skill gets the rule as the editor last wrote it.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(learning.rule);
  const [rewritten, setRewritten] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const reviseButton = useRef<HTMLButtonElement>(null);
  const revised = useRef<Promise<boolean>>(Promise.resolve(true));
  const now = useRef({ editing, draft, rule: learning.rule });
  now.current = { editing: now.current.editing, draft, rule: learning.rule };
  const store = useProjectStore.getState;

  const cancel = useRef(() => {});
  // What the panel's Esc calls while this rule is reworded. It is the same function on every draw, so the row can tell
  // that it is still its own and take it back when the rewording ends: left behind, it would take every later Esc and
  // the list would no longer close on one.
  const [takeEsc] = useState(() => () => cancel.current());
  function finish(keep: boolean) {
    if (!now.current.editing) return;
    now.current.editing = false;
    if (rewording.current === takeEsc) rewording.current = null;
    setEditing(false);
    const rule = now.current.draft.replace(/\s+/g, " ").trim();
    if (!keep || !rule || rule === now.current.rule) { setDraft(now.current.rule); return; }
    setRewritten(rule);
    setError("");
    // An Approve pressed while this saves doesn't go ahead if it fails. The next one approves the rule as it shows.
    const attempt: Promise<boolean> = store().reviseLearning(learning.id, rule).then(() => true, (err: unknown) => {
      setError(errorMessage(err));
      return false;
    }).finally(() => setRewritten(null));
    revised.current = attempt;
    void attempt.then(ok => { if (!ok && revised.current === attempt) revised.current = Promise.resolve(true); });
  }
  cancel.current = () => { finish(false); reviseButton.current?.focus(); };
  function startRewording() {
    now.current.editing = true;
    rewording.current = takeEsc;
    setDraft(d => error ? d : learning.rule);
    setEditing(true);
  }
  useEffect(() => {
    const el = field.current;
    if (!editing || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  // The line grows with the rule as it would wrap, so nothing under it moves while the editor types.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);
  // A press outside closes the list while a rule is being reworded. What the editor wrote is kept, as a press elsewhere in it would.
  useEffect(() => () => {
    if (rewording.current === takeEsc) rewording.current = null;
    const rule = now.current.draft.replace(/\s+/g, " ").trim();
    if (now.current.editing && rule && rule !== now.current.rule) void store().reviseLearning(learning.id, rule).catch(() => {});
  }, [learning.id, rewording, store]);

  async function decide(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await run(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  const problem = error || learning.error;
  // What it replaces was quoted from the skill it was offered for. Sent to another skill, it replaces none of that.
  const replaces = chosen === learning.skillId && learning.replaces?.length ? quoted(learning.replaces) : "";
  const skillName = options.find(o => o.value === chosen)?.label;

  return <li className="learn-item" aria-busy={saving || undefined}>
    {editing ? <textarea ref={field} className="learn-rule learn-rule-edit" aria-label="Rule" rows={1} maxLength={280} spellCheck value={draft}
      onChange={e => setDraft(e.target.value.replace(/[\r\n]+/g, " "))}
      onKeyDown={e => {
        if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
        e.preventDefault();
        // Leaving the line keeps what was written.
        reviseButton.current?.focus();
      }}
      onBlur={() => finish(true)} />
      : <p className="learn-rule">{rewritten ?? learning.rule}</p>}
    <p className="learn-said" title={learning.said}>You said: “{learning.said}”</p>
    {replaces && <p className="learn-replaces" title={`Replaces ${replaces}`}><span className="learn-replaces-label">Replaces</span> {replaces}</p>}
    {problem && !saving && <p className="learn-problem" role={error ? "alert" : undefined}>{error ? problem : `Not saved. ${problem}`}</p>}
    <div className="learn-actions">
      <span className="learn-to">Save to</span>
      {/* A narrow panel cuts the skill's name short, so the whole name is on hover. */}
      <PreferenceSelect compact label="Skill to save this to" options={options} value={chosen} valueLabel={skillName ?? "Choose a skill"} title={skillName}
        disabled={saving || busy} onChange={setSkillId} />
      {/* The decisions keep together at the right, on the name's line or, where it is too narrow for both, under it. */}
      <span className="learn-decide">{saving ? <span className="learn-saving working-text" role="status">Saving…</span> : <>
        {/* Pressed while the rule is being reworded, Revise keeps the new wording. It holds the focus on the line until then. */}
        <button ref={reviseButton} type="button" className="btn-quiet learn-revise" aria-pressed={editing} disabled={busy}
          onMouseDown={e => { if (now.current.editing) e.preventDefault(); }}
          onClick={() => editing ? reviseButton.current?.focus() : startRewording()}>Revise</button>
        <button type="button" className="btn-primary" disabled={busy || !options.length}
          onClick={() => void decide(async () => {
            if (await revised.current) await store().approveLearning(learning.id, chosen, effective ?? undefined);
          })}>Approve</button>
        <button type="button" className="edit-card-icon" aria-label="Decline" title="Decline" disabled={busy}
          onClick={() => void decide(async () => { await revised.current; await store().declineLearning(learning.id); })}><Icon name="x" size={12} /></button>
      </>}</span>
    </div>
  </li>;
}
