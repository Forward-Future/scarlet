import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { agentTarget, type Task, type TaskAttachment } from "@scarlet/shared";
import { canStartCutReview, cutSummary, type Project } from "@scarlet/timeline";
import { recordEditReview, requestPosition } from "../../lib/editReviews";
import { errorMessage, IS_DESKTOP } from "../../lib/client";
import { messageTimestamps, type MessageClock } from "../../lib/messageTimestamps";
import { dropTargets, fileDropZone } from "../../lib/dropTargets";
import { useAttachmentsStore, type PendingAttachment } from "../../stores/attachments";
import { isComposing } from "../../lib/hotkeys";
import { clock, clockRange, lengthLabel, playbackClock } from "../../lib/format";
import type { RecorderResult } from "../../lib/recorder";
import { useSpeech } from "../../lib/speech";
import type { Thread } from "../../lib/threads";
import { useProjectStore } from "../../stores/project";
import { commandSkillIds, enabledSkills, useSkillsStore } from "../../stores/skills";
import { editTargetAt, markedRangeOf, pointOf, playheadPoints, useUiStore, withMarkedRange, type AgentContext } from "../../stores/ui";
import { Icon, Spinner, InlineError } from "../ui/primitives";
import { AgentChip, useAgentAvailability } from "./AgentChip";
import { SkillCommandInput } from "./SkillCommandInput";
import { MicButton } from "./MicButton";
import { ComposerAim, type AimItem } from "./ComposerAim";

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

interface Rewording { id: string; text: string; onChange(text: string): void; onSave(text: string, skillIds?: string[]): Promise<void>; onCancel(): void }

interface ComposerProps {
  /** What sits attached to the top of the message box: the requests queued behind the one Scarlet is on. */
  tray?: ReactNode;
  /** What the message revises, as a tag inside the box before the text: "Cut at 2:05". Its × takes the target off. */
  targetTag?: string;
  /** The tag is a moment a new edit is about ("At 18:28"), not something being revised. Its × makes the message about the whole video. */
  targetIsPoint?: boolean;
  messageClock?: MessageClock;
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

function ComposerBox({ project, thread, onCreated, onSent, selectedEdit, onClearSelectedEdit, modelPicker = true, tray, targetTag, targetIsPoint, onClearTarget, rewording, messageClock }: ComposerProps & { project: Project }) {
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
  // Files dropped or pasted on the box ride on the next message, in a line on top of the box.
  const attached = useAttachmentsStore(s => s.byProject[project.id]) ?? NO_FILES;
  const attach = useAttachmentsStore(s => s.add);
  const detach = useAttachmentsStore(s => s.remove);
  const dock = useRef<HTMLDivElement>(null);
  const [dropping, setDropping] = useState(false);
  // The desktop app's drops arrive as paths, routed by where the pointer is: the box takes them over the workspace,
  // which would add them to the project's media.
  const attachPaths = useRef((paths: string[]) => attach(project.id, paths.map(path => ({ path }))));
  attachPaths.current = (paths: string[]) => attach(project.id, paths.map(path => ({ path })));
  useLayoutEffect(() => {
    const el = dock.current;
    if (!el) return;
    dropTargets.set(el, { highlight: setDropping, drop: paths => attachPaths.current(paths) });
    return () => { dropTargets.delete(el); };
  }, []);

  // A key that gives the box the cursor (N, R) may still be held as it arrives. Its repeats are that same press, not
  // text: they would type "nnn" into the message. The next key pressed is the first one typed.
  const arrivedByKey = useRef(false);
  useEffect(() => {
    if (focusTick && inputRef.current) {
      const field = inputRef.current;
      if (document.activeElement !== field) {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }
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
  /** Sends the message, and says whether the files attached to it went with it. An answer to Scarlet's question can't carry any: they wait for the next message. */
  const send = async (text: string, voiceTranscript?: string, anchor = displayAnchor, skillIds?: string[], files?: TaskAttachment[]): Promise<boolean> => {
    const attachments = files?.length ? files : undefined;
    const carried = attachments && { attachments };
    if (question) {
      const answer = anchor?.editNumber ? `${[`Edit ${anchor.editNumber}`, anchor.label].filter(Boolean).join(" · ")} — ${text}`
        : anchor ? `At ${anchor.markedRange ? clockRange(anchor.time, anchor.end ?? anchor.time) : clock(anchor.time)}${sourceName ? ` in ${sourceName}` : ""} — ${text}` : text;
      await answerTask(question.id, answer, skillIds);
      return false;
    }
    if (!effective) throw new Error(unavailableReason);
    let context: Parameters<typeof createTask>[1]["context"];
    if (replying) {
      if (anchor?.changeId && ![...thread.changes, ...thread.flagged ?? []].some(c => c.id === anchor.changeId)) throw new Error("This suggestion is unavailable. Select the edit again.");
      const position = anchor && requestPosition(anchor);
      // A revision takes no files, so one that carries some is a request in the thread, as a reply is.
      if (revising && !attachments) {
        await revise(revising.id, { text, skillIds, voiceTranscript, assignTo: agentTarget(effective.agent, effective.model),
          effort: effective.effort, serviceTier: effective.serviceTier, ...(position && { position }) });
        recordEditReview(project.id, anchor, "revise");
        return true;
      }
      context = { skillIds, version: head, ...position, threadId: thread.id, ...carried };
    } else if (anchor?.mediaId) {
      context = { skillIds, version: anchor.version ?? head, mediaId: anchor.mediaId, time: anchor.time, end: anchor.end, ...carried };
    } else if (anchor && attachments) {
      // A note at a moment takes no files, so a message that carries some is a request about that moment.
      context = { skillIds, version: anchor.version ?? head, time: anchor.time, end: anchor.end, clipIds: anchor.clipIds, markedRange: anchor.markedRange, ...carried };
    } else if (anchor) {
      const { task } = await createNote(project.id, { skillIds, time: anchor.time, end: anchor.end, clipIds: anchor.clipIds, text, voiceTranscript, version: anchor.version ?? head, assignTo: agentTarget(effective.agent, effective.model), effort: effective.effort, serviceTier: effective.serviceTier });
      if (task) onCreated?.(task);
      return true;
    } else {
      context = { skillIds, version: head, ...carried };
    }
    const task = await createTask(project.id, { kind: "edit", ...effective, instruction: text, voiceTranscript, context });
    // A reply stays in its thread; anything else is a new request the page goes to.
    if (replying) recordEditReview(project.id, anchor, "revise");
    else onCreated?.(task);
    return true;
  };
  /** The files ready to go with a message, once any still being added have landed, and taking them off the line once it's out. */
  const filesFor = async () => {
    if (!useAttachmentsStore.getState().byProject[project.id]?.length) return { files: undefined, done: () => {} };
    const ready = await useAttachmentsStore.getState().settled(project.id);
    return { files: ready.flatMap(a => a.attachment ?? []), done: (carried: boolean) => {
      if (carried) useAttachmentsStore.getState().sent(project.id, ready.map(a => a.key));
    } };
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
      const { files, done } = await filesFor();
      done(await send(text, undefined, displayAnchor, skillIds, files));
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
      const { files, done } = await filesFor();
      done(await send(text, text, anchor, undefined, files));
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

  // A new note uses the first timestamp in its text. Replies, selected transcript words and marked ranges already
  // have a destination. A saved point stays on its original source/version even if the editor browses elsewhere.
  const typedPoint = context && context !== "whole" && context.fromMessage ? context : undefined;
  // Only a message the editor hasn't aimed takes its place from its words. A moment they picked stays where it is
  // whatever times are typed, and once they took the aim off with × ("whole") a typed time doesn't put it back.
  const aimsByText = !context || !!typedPoint;
  const inputClock = !replying && !rewording && (!displayAnchor || pointOf(displayAnchor)) ? messageClock : undefined;
  const sameClock = !typedPoint || (typedPoint.version === inputClock?.version && typedPoint.mediaId === inputClock?.mediaId);
  const duration = inputClock?.duration ?? 0;
  const times = useMemo(() => messageTimestamps(value, duration), [value, duration]);
  const firstTime = times[0]?.time;
  useLayoutEffect(() => {
    if (rewording || replying || !aimsByText) return;
    if (typedPoint && !sameClock && messageTimestamps(value, Infinity).some(t => t.time === typedPoint.time)) return;
    if (inputClock && firstTime !== undefined) {
      if (sameClock && firstTime === typedPoint?.time) return;
      setContext({ ...editTargetAt(firstTime, inputClock.version, inputClock.timeline, inputClock.mediaId), fromMessage: true });
    } else if (typedPoint) setContext(null);
  }, [value, firstTime, inputClock, typedPoint, sameClock, rewording, replying, aimsByText, setContext]);
  const tagWords = targetTag && `${targetTag.charAt(0).toLowerCase()}${targetTag.slice(1)}`;
  // What the tag's message does, for its hover note: a cut or an edit is revised, a question answered, an edit replied to.
  const tagAct = !targetTag ? undefined : question && targetTag === "Answer" ? "Answering Scarlet’s question"
    : thread && targetTag === "Reply" ? "Replying to this edit" : `Revising ${tagWords === "whole edit" ? "the whole edit" : tagWords}`;
  const tag = rewording ? undefined : targetTag;
  // A stretch marked on the timeline's ruler rides with the message, beside the tag of the cut or edit it is aimed at.
  const marked = rewording ? undefined : markedRangeOf(context);
  const markedWords = marked && clockRange(marked.start, marked.end);
  // "Answer" and "Reply" say in words who the message goes to. Anything with a place (a cut, an edit, a moment, a
  // marked stretch) folds into the edit-point icon, which keeps one size however much it holds.
  const wordTag = tag === "Answer" || tag === "Reply" ? tag : undefined;
  const placeTag = wordTag ? undefined : tag;
  const takeOffTarget = () => {
    if (onClearTarget) onClearTarget(); else setContext("whole");
    inputRef.current?.focus();
  };
  const aimItems: AimItem[] = [
    ...placeTag ? [{ key: `target:${placeTag}`, kind: "target" as const, name: placeTag,
      detail: targetIsPoint ? "the moment you picked" : /^cut\b/i.test(placeTag) ? "the cut that’s open" : /^edit\b/i.test(placeTag) ? "the edit that’s open" : "what you’re revising",
      clearLabel: targetIsPoint ? `Take “${placeTag}” off: the message is about the whole video` : `Start a new edit instead of ${tagAct!.charAt(0).toLowerCase()}${tagAct!.slice(1)}`,
      onClear: takeOffTarget }] : [],
    ...marked ? [{ key: `range:${marked.start}/${marked.end}`, kind: "range" as const, name: markedWords!, detail: `${lengthLabel(marked.end - marked.start)} you marked`,
      clearLabel: `Take the marked range ${markedWords} off the message`, onClear: () => {
        const was = context && context !== "whole" ? context : undefined;
        setContext(withMarkedRange(context, undefined), was?.changeId ? was : undefined);
        inputRef.current?.focus();
      } }] : [],
  ];
  const saveLabel = rewording ? "Save the new words" : sendLabel;
  function changeText(text: string) {
    dismissFirstEditHint();
    setError("");
    if (rewording) return rewording.onChange(text);
    if (text.trim()) captureTarget();
    else if (context && context !== "whole" && playheadPoints.has(context)) setContext(null);
    setRefused(false);
    setDraft(text);
  }
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
      {attached.length > 0 && <AttachedFiles files={attached} onRemove={key => { detach(project.id, key); inputRef.current?.focus(); }} />}
      {/* Esc leaves a queued request's words as they were, unless the skill list took it first. */}
      {/* While an input method composes, Esc is its own: it puts away its candidates, and the words stay in the box. */}
      {/* Backspace in an empty box takes a picked moment off, as it would a tag. A held Backspace that just emptied the box doesn't. */}
      <div className={firstEditHint ? "composer-box first-edit-hint" : "composer-box"} onKeyDown={e => {
        if (rewording && e.key === "Escape" && !e.defaultPrevented && !isComposing(e)) rewording.onCancel();
        if (e.key === "Backspace" && !e.repeat && !e.defaultPrevented && !isComposing(e) && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey &&
            placeTag && targetIsPoint && !recording && !heard && e.target === inputRef.current && !inputRef.current.value) {
          e.preventDefault();
          takeOffTarget();
        }
      }}
        onKeyDownCapture={e => {
          if (!e.repeat) arrivedByKey.current = false;
          else if (arrivedByKey.current) e.preventDefault();
        }}
        // A file pasted into the box is attached, as one dropped on it is. Pasted words are typed as usual.
        onPaste={e => {
          const files = Array.from(e.clipboardData?.files ?? []);
          if (!files.length || rewording) return;
          e.preventDefault();
          attach(project.id, files);
        }}>
        <label htmlFor={inputId} className="composer-destination sr-only">{rewording ? "Changing the words of a queued request" : <>{mode}{editTitle && ` ${editTitle}`}</>}</label>
        <div className="composer-row">
          {/* Mounted with nothing aimed too, so the first thing added to an empty box arrives: it draws nothing until then. */}
          {!rewording && <ComposerAim items={aimItems}disabled={recording || heard} disabledReason="Waits until what you’re saying is sent" />}
          {wordTag && <span className="composer-tag" title={tagAct}>
            <span className="composer-tag-name">{wordTag}</span>
            {/* A spoken message stays where it was said until it is out: aiming the box elsewhere would drop it. */}
            <button type="button" className="composer-tag-clear" disabled={recording || heard}
              aria-label={`Start a new edit instead of ${tagAct!.charAt(0).toLowerCase()}${tagAct!.slice(1)}`}
              title={recording || heard ? "Waits until what you’re saying is sent" : "New edit instead"} onClick={takeOffTarget}><Icon name="x" size={10} /></button>
          </span>}
          <SkillCommandInput key={owner} id={inputId} inputRef={inputRef} value={value} skills={skills}
            placeholder={rewording ? "What should it ask instead?" : question ? "Answer Scarlet…" : displayAnchor?.changeId && context ? "What should change?" : replying ? "Write a follow-up…" : NEW_EDIT_HINT}
            timestamps={sameClock ? times : undefined} onTimestamp={inputClock?.seek} onChange={changeText} onSubmit={() => void submitText()} />
          {/* The reason is only for a mic with no agent to talk to. While a message sends or is written down the spinner says why. */}
          <MicButton onResult={(r) => void onVoice(r)} onStart={() => {
            dismissFirstEditHint();
            setError("");
            voiceReword.current = rewording ? rewordSession : undefined;
            if (!voiceReword.current) voiceAnchor.current = captureTarget();
          }} onRecording={setRecording} onError={setError} followHold disabled={unavailable || busy || speech.busy} disabledReason={unavailable ? unavailableReason : undefined} label="Talk to Scarlet" />
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

  // Files dropped on the box attach to the message. Dropped anywhere else in the workspace, they're added to the project.
  return <div ref={dock} data-file-drop="" className={none ? "composer-dock needs-agent" : "composer-dock"}
    onDragOver={e => {
      if (!IS_DESKTOP && e.dataTransfer.types.includes("Files") && fileDropZone(e.target) === e.currentTarget) {
        e.preventDefault();
        e.stopPropagation();
        setDropping(true);
      }
    }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
    onDrop={e => {
      setDropping(false);
      if (!IS_DESKTOP && e.dataTransfer.files.length && fileDropZone(e.target) === e.currentTarget) {
        e.preventDefault();
        e.stopPropagation();
        attach(project.id, Array.from(e.dataTransfer.files));
      }
    }}>
    <InlineError>{error || (refused && unavailable && unavailableReason)}</InlineError>
    {editor}
    {dropping && <div className="composer-drop" aria-hidden="true">Attach to your message</div>}
  </div>;
}

/** What the empty box says when the message would start a new edit. */
export const NEW_EDIT_HINT = "Describe an edit, / skills, $ templates";

const NO_FILES: PendingAttachment[] = [];

/**
 * The files the next message carries, as a line attached to the top of the box, one row each, as the queue's rows
 * read: a file mark, the name, and × to take it off. A file still on its way into the project is dim and says so; one
 * that couldn't be added says why.
 */
function AttachedFiles({ files, onRemove }: { files: readonly PendingAttachment[]; onRemove(key: string): void }) {
  return <div className="composer-files" role="group" aria-label="Files attached to your message">
    {files.map(file => <div key={file.key} className={`composer-file is-${file.state}`} title={file.error ? `${file.name}: ${file.error}` : file.name}>
      <span className="composer-file-icon"><Icon name="file" size={12} /></span>
      <span className="composer-file-name">{file.name}</span>
      {file.state === "adding" && <span className="composer-file-state" role="status">Adding…</span>}
      {file.state === "failed" && <span className="composer-file-state is-bad" role="alert">{file.error ?? "Couldn’t add it"}</span>}
      <button type="button" className="composer-file-remove" aria-label={`Remove ${file.name}`} title="Remove" onClick={() => onRemove(file.key)}><Icon name="x" size={11} /></button>
    </div>)}
  </div>;
}
