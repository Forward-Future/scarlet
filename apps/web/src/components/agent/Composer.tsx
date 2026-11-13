import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { agentTarget, type Task } from "@scarlet/shared";
import { canStartCutReview, cutSummary, type Project } from "@scarlet/timeline";
import { recordEditReview, requestPosition } from "../../lib/editReviews";
import { errorMessage } from "../../lib/client";
import { isComposing } from "../../lib/hotkeys";
import { clock, playbackClock } from "../../lib/format";
import type { RecorderResult } from "../../lib/recorder";
import { useSpeech } from "../../lib/speech";
import type { Thread } from "../../lib/threads";
import { useProjectStore } from "../../stores/project";
import { commandSkillIds, enabledSkills, useSkillsStore } from "../../stores/skills";
import { playheadPoints, useUiStore, type AgentContext } from "../../stores/ui";
import { Icon, Spinner, InlineError } from "../ui/primitives";
import { AgentChip, useAgentAvailability } from "./AgentChip";
import { SkillCommandInput } from "./SkillCommandInput";
import { MicButton } from "./MicButton";

const timestampLabel = (time: number) => playbackClock(time).replace(/\.000$/, "");

/** A focused request takes replies. The cut can take a timestamped note or a new project request. */
/** `modelPicker={false}` leaves the model choice to the page, which shows it elsewhere. */
/** `onSent` runs once a message has gone out and left the box empty and aimed at nothing: a new edit, a reply, a revision or an answer. Text typed or a target set while it was on its way is the next message's, and then it doesn't run. */
export function Composer(props: ComposerProps) {
  const project = useProjectStore(s => s.current?.project);
  // The box is its own component, so every hook of it runs on each of its renders: a project opening or closing under
  // a box already on the page mounts or unmounts it instead of changing how many hooks run.
  return project ? <ComposerBox {...props} project={project} /> : null;
}

export interface Rewording { id: string; text: string; onChange(text: string): void; onSave(text: string, skillIds?: string[]): Promise<void>; onCancel(): void }

interface ComposerProps {
  /** What sits attached to the top of the message box: the requests queued behind the one Scarlet is on. */
  tray?: ReactNode;
  /** What the message revises, as a tag inside the box before the text: "Cut at 2:05". Its × takes the target off. */
  targetTag?: string;
  /** The tag is a moment a new edit is about ("At 18:28"), not something being revised. Its × makes the message about the whole video. */
  targetIsPoint?: boolean;
  /** A moment the editor navigated to and can attach to this message. */
  editHere?: { time: string; onSelect(): void };
  /** What taking the tag off does. Without it, the message becomes a reply to the whole request. */
  onClearTarget?(): void;
  /**
   * The box is changing the words of a request still in the queue instead of writing a message: it shows `text` alone,
   * across its whole width, and sending saves them. The request's row in the tray says which it is, so the box has no
   * tag then. Esc leaves them as they were. A message being written waits meanwhile in the store, and comes back once
   * the box is done with the queued one.
   */
  rewording?: Rewording;
  selectedEdit?: AgentContext; onClearSelectedEdit?(): void; thread?: Thread; onCreated?(task: Task): void; onSent?(): void; modelPicker?: boolean }

function ComposerBox({ project, thread, onCreated, onSent, selectedEdit, onClearSelectedEdit, modelPicker = true, tray, targetTag, targetIsPoint, onClearTarget, rewording, editHere }: ComposerProps & { project: Project }) {
  const media = useProjectStore(s => s.current?.media);
  const createTask = useProjectStore((s) => s.createTask);
  const createNote = useProjectStore((s) => s.createNote);
  const createVoiceNote = useProjectStore((s) => s.createVoiceNote);
  const revise = useProjectStore((s) => s.revise);
  const context = useUiStore((s) => s.agentContext);
  const setContext = useUiStore((s) => s.setAgentContext);
  const draft = useUiStore((s) => s.agentDraft);
  const setDraft = useUiStore((s) => s.setAgentDraft);
  const firstEditHint = useUiStore(s => s.firstEditHint === project.id);
  const dismissFirstEditHint = useUiStore(s => s.dismissFirstEditHint);
  const owner = useUiStore(s => s.draftOwner);
  const clearSentDraft = useUiStore(s => s.clearSentDraft);
  const keepUnsent = useUiStore(s => s.keepUnsent);
  const answerTask = useProjectStore((s) => s.answerTask);
  const focusTick = useUiStore((s) => s.composerFocus);
  const [error, setError] = useState("");
  // Enter was pressed with no agent or model to send to. The line under the box says why for as long as that is so.
  const [refused, setRefused] = useState(false);
  const { effective, none, unavailableReason } = useAgentAvailability();
  const [busy, setBusy] = useState(false);
  const voiceAnchor = useRef<AgentContext | null | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const library = useSkillsStore(s => s.skills);
  const skills = useMemo(() => enabledSkills(library), [library]);

  // A key that gives the box the cursor (N, R) may still be held as it arrives. Its repeats are that same press, not
  // text: they would type "nnn" into the message. The next key pressed is the first one typed.
  const arrivedByKey = useRef(false);
  useEffect(() => {
    if (focusTick && inputRef.current) {
      inputRef.current.focus();
      arrivedByKey.current = true;
      useUiStore.setState({ composerFocus: 0 });
    }
  }, [focusTick]);
  // A queued request's words come into the box ready to change, with the caret after them.
  // A transcript can arrive after Esc, even after the editor reopens the same request.
  const rewordSession = useMemo<{ request?: Rewording }>(() => ({}), [rewording?.id]);
  useLayoutEffect(() => {
    rewordSession.request = rewording;
    return () => { rewordSession.request = undefined; };
  }, [rewordSession, rewording]);
  useEffect(() => {
    const input = inputRef.current;
    if (!rewording || !input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [rewording?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const value = rewording ? rewording.text : draft;
  // The queued request a recording was begun for. What is said belongs to the box as it was when the microphone opened.
  const voiceReword = useRef<typeof rewordSession>(undefined);
  const saveWords = async (request: Rewording, text: string) => {
    setError("");
    setBusy(true);
    try {
      // The new words run the skills their /commands name, as they would if sent so, and no longer the old words' skills.
      await request.onSave(text, await commandSkillIds(text));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const head = project.head ?? undefined;
  const displayAnchor = context === "whole" ? null : context ?? selectedEdit ?? null;
  const replying = !!thread;
  const question = replying && (!displayAnchor?.changeId || selectedEdit) ? thread.question : undefined;
  // An answer goes to the agent that asked. Anything else needs an agent and a model to send to.
  const unavailable = !question && none;
  const pinnedChange = displayAnchor?.changeId && thread?.changes.find(c => c.id === displayAnchor.changeId);
  const olderCutProposal = thread?.latest?.state === "ready" && thread.latest.fromVersion !== head && canStartCutReview(thread.latest);
  const revising = replying && (!olderCutProposal || pinnedChange === thread.latest) && !thread.active && (!displayAnchor?.changeId || pinnedChange === thread.latest) &&
    (thread.latest?.state === "ready" || thread.latest?.state === "failed") ? thread.latest : undefined;
  const spot = displayAnchor?.editIndex ?? displayAnchor?.cutIndex;
  const numberedEdit = displayAnchor?.editNumber ?? (spot !== undefined ? spot + 1 : undefined);
  const editTitle = numberedEdit ? displayAnchor?.label ?? `Edit ${numberedEdit}` : thread && cutSummary(thread.title);
  const mode = !thread ? "New thread" : displayAnchor?.changeId && !numberedEdit && !selectedEdit ? "Revising" : "Reply to";
  const sendLabel = !thread ? "Start new edit" : question ? "Send answer" : displayAnchor?.changeId ? "Send revision" : "Send reply";
  const timestamp = displayAnchor && `${timestampLabel(displayAnchor.time)}${displayAnchor.end === undefined ? "" : `–${timestampLabel(displayAnchor.end)}`}`;
  const targetName = numberedEdit ? `Edit ${numberedEdit}` : displayAnchor?.changeId ? displayAnchor.label || editTitle || timestamp : timestamp;
  const sourceName = displayAnchor?.mediaId && media?.find(m => m.id === displayAnchor.mediaId)?.name;
  const targetDetails = [...new Set([targetName, sourceName, displayAnchor?.label].filter(Boolean))].join(" · ");
  const removeTarget = displayAnchor?.changeId ? "Remove revision target" : "Remove timestamp";
  // A reply keeps its original edit if the selection changes while the editor types or dictates.
  const captureTarget = () => {
    if (replying && !context) setContext(selectedEdit ?? "whole");
    return displayAnchor;
  };

  /** Continue the focused thread, start a note at a moment, or start a new request. */
  const send = async (text: string, voiceTranscript?: string, anchor = displayAnchor, skillIds?: string[]) => {
    if (question) {
      const answer = anchor?.editNumber ? `${[`Edit ${anchor.editNumber}`, anchor.label].filter(Boolean).join(" · ")} — ${text}`
        : anchor ? `At ${clock(anchor.time)}${sourceName ? ` in ${sourceName}` : ""} — ${text}` : text;
      await answerTask(question.id, answer, skillIds);
      return;
    }
    if (!effective) throw new Error(unavailableReason);
    if (replying) {
      if (anchor?.changeId && !thread.changes.some(c => c.id === anchor.changeId)) throw new Error("This suggestion is unavailable. Select the edit again.");
      const position = anchor && requestPosition(anchor);
      if (revising) {
        await revise(revising.id, { text, skillIds, voiceTranscript, assignTo: agentTarget(effective.agent, effective.model),
          effort: effective.effort, serviceTier: effective.serviceTier, ...(position && { position }) });
      } else {
        await createTask(project.id, { kind: "edit", ...effective, instruction: text, voiceTranscript, context: { skillIds, version: head, ...position, threadId: thread.id } });
      }
      recordEditReview(project.id, anchor, "revise");
    } else if (anchor?.mediaId) {
      const task = await createTask(project.id, { kind: "edit", ...effective, instruction: text, voiceTranscript,
        context: { skillIds, version: anchor.version ?? head, mediaId: anchor.mediaId, time: anchor.time, end: anchor.end } });
      onCreated?.(task);
    } else if (anchor) {
      const { task } = await createNote(project.id, { skillIds, time: anchor.time, end: anchor.end, clipIds: anchor.clipIds, text, voiceTranscript, version: anchor.version ?? head, assignTo: agentTarget(effective.agent, effective.model), effort: effective.effort, serviceTier: effective.serviceTier });
      if (task) onCreated?.(task);
    } else {
      const task = await createTask(project.id, { kind: "edit", ...effective, instruction: text, voiceTranscript, context: { skillIds, version: head } });
      onCreated?.(task);
    }
  };

  // Whether the box has nothing left for the next message: no text, and no target the editor aimed it at meanwhile.
  const boxIsFree = () => {
    const box = useUiStore.getState();
    return box.draftOwner !== owner || (!box.agentDraft && (!box.agentContext || box.agentContext === "whole"));
  };

  const submitText = async () => {
    if (rewording) {
      const words = rewording.text.trim();
      if (words && !busy && !speech.busy) await saveWords(rewording, words);
      return;
    }
    const text = draft.trim();
    if (!text || text === "/" || busy || speech.busy) return;
    // Nothing can take the message. Enter says why under the box, where it used to do nothing.
    if (unavailable) return setRefused(true);
    setError("");
    setRefused(false);
    setBusy(true);
    try {
      const skillIds = await commandSkillIds(draft);
      await send(text, undefined, displayAnchor, skillIds);
      clearSentDraft(owner, { agentDraft: draft, agentContext: context });
      if (boxIsFree()) onSent?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // Voice: notes at a moment keep the recording; everything else is just text.
  // A message typed but not sent stays in the box, still aimed where it was, even one typed while the spoken one was on its way.
  const clearVoiceTarget = (anchor: AgentContext | null) => {
    const box = useUiStore.getState();
    if (box.draftOwner === owner && box.agentDraft) return;
    clearSentDraft(owner, { agentDraft: "", agentContext: anchor ?? context ?? (replying ? "whole" : null) });
    if (boxIsFree()) onSent?.();
  };
  const speech = useSpeech(async (text) => {
    // Said while the box held a queued request's words: what was said takes their place. Words the editor put back
    // meanwhile stay as they were, and what was said for them is not sent as a new request.
    if (voiceReword.current) return voiceReword.current.request?.onSave(text);
    const anchor = voiceAnchor.current === undefined ? displayAnchor : voiceAnchor.current;
    try {
      await send(text, text, anchor);
    } catch (e) {
      // What was said isn't lost with the failed send: it waits in the box it was said into, which is kept through a
      // quit, still aimed where it was sent. Another request's box the editor turned to meanwhile is left as it is.
      keepUnsent(owner, { agentDraft: text, agentContext: anchor ?? context ?? null });
      throw e;
    }
    clearVoiceTarget(anchor);
  }, setError);
  // A spoken message is in the box from the moment the microphone is asked for until it is sent or dropped. The page
  // keeps the box aimed where it was meanwhile, as it does for typed words: aiming it elsewhere builds the box again,
  // which would drop the recording, or send the rest of what is said to whatever the box is aimed at then.
  const [recording, setRecording] = useState(false);
  const [heard, setHeard] = useState(false);
  const setSpeaking = useUiStore(s => s.setSpeaking);
  useEffect(() => setSpeaking(recording || heard), [recording, heard, setSpeaking]);
  useEffect(() => () => setSpeaking(false), [setSpeaking]);
  const onVoice = async (r: RecorderResult) => {
    const anchor = voiceAnchor.current === undefined ? displayAnchor : voiceAnchor.current;
    setError("");
    setHeard(true);
    try {
      if (voiceReword.current || replying || !anchor || anchor.mediaId || !effective) return await speech.handle(r);
      setBusy(true);
      try {
        const { task } = await createVoiceNote(project.id, r.blob, { time: anchor.time, end: anchor.end, clipIds: anchor.clipIds, version: anchor.version ?? head, assignTo: agentTarget(effective.agent, effective.model), effort: effective.effort, serviceTier: effective.serviceTier });
        if (task) onCreated?.(task);
        clearVoiceTarget(anchor);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    } finally {
      setHeard(false);
    }
  };

  const tagWords = targetTag && `${targetTag.charAt(0).toLowerCase()}${targetTag.slice(1)}`;
  // What the tag's message does, for its hover note: a cut or an edit is revised, a question answered, an edit replied to.
  const tagAct = !targetTag ? undefined : question && targetTag === "Answer" ? "Answering Scarlet’s question"
    : thread && targetTag === "Reply" ? "Replying to this edit" : `Revising ${tagWords === "whole edit" ? "the whole edit" : tagWords}`;
  const tag = rewording ? undefined : targetTag;
  const saveLabel = rewording ? "Save the new words" : sendLabel;
  const editor = (
    <div className="composer-input">
      <div className="composer-context-row">
        {targetName && !rewording && <div className="composer-scope" title={targetDetails}>
          <Icon name={displayAnchor?.changeId ? "film" : "clock"} size={12} />
          <span className="composer-target-name">{targetName}</span>
          <button type="button" className="composer-target-clear" aria-label={removeTarget} aria-description={targetDetails}
            title={`${removeTarget} · ${targetDetails}`}
            onClick={() => {
              if (selectedEdit) onClearSelectedEdit?.();
              setContext("whole");
              inputRef.current?.focus();
            }}><Icon name="x" size={11} /></button>
        </div>}
        {modelPicker && <div className="composer-model"><AgentChip threadInput={thread ? question ? "answer" : "reply" : undefined} /></div>}
      </div>
      {tray}
      {/* Esc leaves a queued request's words as they were, unless the skill list took it first. */}
      {/* While an input method composes, Esc is its own: it puts away its candidates, and the words stay in the box. */}
      <div className={firstEditHint ? "composer-box first-edit-hint" : "composer-box"} onKeyDown={e => { if (rewording && e.key === "Escape" && !e.defaultPrevented && !isComposing(e)) rewording.onCancel(); }}
        onKeyDownCapture={e => {
          if (!e.repeat) arrivedByKey.current = false;
          else if (arrivedByKey.current) e.preventDefault();
        }}>
        <label htmlFor={inputId} className="composer-destination sr-only">{rewording ? "Changing the words of a queued request" : <>{mode}{editTitle && ` ${editTitle}`}</>}</label>
        <div className="composer-row">
          {tag && <span className="composer-tag" title={targetIsPoint ? `About the video ${tagWords}` : tagAct}>
            <span className="composer-tag-name">{tag}</span>
            {/* A spoken message stays where it was said until it is out: aiming the box elsewhere would drop it. */}
            <button type="button" className="composer-tag-clear" disabled={recording || heard}
              aria-label={targetIsPoint ? `Take “${targetTag}” off: the message is about the whole video` : `Start a new edit instead of ${tagAct!.charAt(0).toLowerCase()}${tagAct!.slice(1)}`}
              title={recording || heard ? "Waits until what you’re saying is sent" : targetIsPoint ? "Whole video instead" : "New edit instead"} onClick={() => {
                if (onClearTarget) onClearTarget(); else setContext("whole");
                inputRef.current?.focus();
              }}><Icon name="x" size={10} /></button>
          </span>}
          <SkillCommandInput key={owner} id={inputId} inputRef={inputRef} value={value} skills={skills}
            placeholder={rewording ? "What should it ask instead?" : question ? "Answer Scarlet…" : displayAnchor?.changeId && context ? "What should change?" : replying ? "Write a follow-up…" : "Describe your edit or type / for skills"}
            onChange={text => {
              dismissFirstEditHint();
              setError("");
              if (rewording) return rewording.onChange(text);
              if (text.trim()) captureTarget();
              else if (context && context !== "whole" && playheadPoints.has(context)) setContext(null);
              setRefused(false); setDraft(text);
            }} onSubmit={() => void submitText()} />
          {editHere && !tag && !rewording && !replying && !displayAnchor && !recording && !heard && <button type="button" className="composer-edit-here"
            aria-label={`Edit here at ${editHere.time}`} title={`Edit here at ${editHere.time}`} onClick={() => {
              editHere.onSelect();
              inputRef.current?.focus();
            }}>Edit here</button>}
          {/* The reason is only for a mic with no agent to talk to. While a message sends or is written down the spinner says why. */}
          <MicButton onResult={(r) => void onVoice(r)} onStart={() => {
            dismissFirstEditHint();
            voiceReword.current = rewording ? rewordSession : undefined;
            if (!voiceReword.current) voiceAnchor.current = captureTarget();
          }} onRecording={setRecording} followHold disabled={unavailable || busy || speech.busy} disabledReason={unavailable ? unavailableReason : undefined} label="Talk to Scarlet" />
          {(busy || speech.busy) && <Spinner className="size-3.5 shrink-0" />}
          {/* Shown once there's something to send (Enter sends too). Stopping an edit is on its card, where its progress is. */}
          {value.trim() && <button type="button" className={rewording ? "btn-primary composer-send is-save shrink-0" : "btn-primary composer-send shrink-0"} aria-label={saveLabel} title={saveLabel}
            disabled={busy || speech.busy || (!rewording && (draft.trim() === "/" || unavailable))} onClick={() => void submitText()}>
            <Icon name={rewording ? "check" : "arrow"} size={15} />
          </button>}
        </div>
      </div>
    </div>
  );

  return <div className={none ? "composer-dock needs-agent" : "composer-dock"}>
    <InlineError>{error || (refused && unavailable && unavailableReason)}</InlineError>
    {editor}
  </div>;
}
