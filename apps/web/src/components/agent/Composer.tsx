import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { agentTarget, type PictureMarks, type Task, type TaskAttachment } from "@scarlet/shared";
import { canStartCutReview, cutSummary, type Project } from "@scarlet/timeline";
import { recordEditReview, requestPosition } from "../../lib/editReviews";
import { recordUndo } from "../../lib/undo";
import { errorMessage } from "../../lib/client";
import { aimKind, failure, requestLog } from "../../lib/requestLog";
import { messageTimestamps, type MessageClock } from "../../lib/messageTimestamps";
import { useFileDropTarget } from "../../lib/uiHooks";
import { useAttachmentsStore } from "../../stores/attachments";
import { usePictureMarksStore } from "../../stores/pictureMarks";
import { player } from "../../lib/player";
import { toggleMarking } from "../player/PictureMarks";
import { isAltClearRangeKey, isComposing } from "../../lib/hotkeys";
import { clock, clockRange, playbackClock, preciseRange } from "../../lib/format";
import type { RecorderResult } from "../../lib/recorder";
import { useSpeech } from "../../lib/speech";
import type { Thread } from "../../lib/threads";
import { useProjectStore } from "../../stores/project";
import { commandSkillIds, enabledSkills, useSkillsStore } from "../../stores/skills";
import { editTargetAt, markedRangeOf, pointOf, playheadPoints, useUiStore, withMarkedRange, type AgentContext } from "../../stores/ui";
import { Icon, Spinner, InlineError } from "../ui/primitives";
import { AgentChip, CONNECTING_REASON, runChoiceDiffers, useAgentAvailability, useModelsConnecting } from "./AgentChip";
import { SkillCommandInput } from "./SkillCommandInput";
import { MicButton } from "./MicButton";
import { AimTimecode, ComposerAim, type AimItem } from "./ComposerAim";
import { AttachedFiles, NO_FILES, sendMarks } from "./ComposerAttachments";

const timestampLabel = (time: number) => playbackClock(time).replace(/\.000$/, "");
const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
/** The agent, model, effort and speed a note or a revision is given to: the run choice the box is set to. */
const assignment = (run: NonNullable<ReturnType<typeof useAgentAvailability>["effective"]>) =>
  ({ assignTo: agentTarget(run.agent, run.model), effort: run.effort, serviceTier: run.serviceTier });

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

export interface PausedAt { time: number; version?: string; mediaId?: string }

interface ComposerProps {
  /** What sits attached to the top of the message box: the requests queued behind the one Scarlet is on. */
  tray?: ReactNode;
  /** What the message revises, as a tag inside the box before the text: "Cut at 2:05". Its × takes the target off. */
  targetTag?: string;
  /** Which of the questions that wait this answer is for, when Scarlet has asked several: "1 of 2". They are answered one at a time, in the order asked. */
  targetTagNote?: string;
  /** The tag is a moment a new edit is about ("At 18:28"), not something being revised. Its × makes the message about the whole video. */
  targetIsPoint?: boolean;
  messageClock?: MessageClock;
  /** What taking the tag off does. Without it, the message becomes a reply to the whole request. */
  onClearTarget?(): void;
  /** ⌘Z in an empty box puts back the tag Backspace or its × just took off. Says whether there was one to put back. */
  onRestoreTarget?(): boolean;
  /**
   * The box is changing the words of a request still in the queue instead of writing a message: it shows `text` alone,
   * across its whole width, and sending saves them. The request's row in the tray says which it is, so the box has no
   * tag then. Esc leaves them as they were. A message being written waits meanwhile in the store, and comes back once
   * the box is done with the queued one.
   */
  rewording?: Rewording;
  /**
   * Where the editor paused the video while a cut or an edit is open, on the timeline the player showed. The tag shows
   * that time in place of the cut's or the edit's; the message is still theirs, and Scarlet is told the frame too.
   */
  pausedAt?: PausedAt;
  /** Where the cut a call's tag names ("Cut 3") is in the video, shown after a dot ("Cut 3 · 2:47"). */
  aimTime?: number;
  /** Exact time for a time-based target tag ("Cut at 2:05", "Edit at 0:11"), shown to the millisecond above the box. */
  targetTime?: number;
  selectedEdit?: AgentContext; onClearSelectedEdit?(): void; thread?: Thread; onCreated?(task: Task): void; onSent?(): void; modelPicker?: boolean }

function ComposerBox({ project, thread, onCreated, onSent, selectedEdit, onClearSelectedEdit, modelPicker = true, tray, targetTag, targetTagNote, targetIsPoint, onClearTarget, onRestoreTarget, rewording, messageClock, pausedAt, aimTime, targetTime }: ComposerProps & { project: Project }) {
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
  const availability = useAgentAvailability();
  const { effective, none } = availability;
  // While Scarlet is still finding its models the header says "Connecting…", and the box says the same, not "Sign in".
  const unavailableReason = useModelsConnecting(availability) ? CONNECTING_REASON : availability.unavailableReason;
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
  // Marks drawn on the picture ride on the next message too, as their frame on a row of that line.
  const markedFrame = usePictureMarksStore(s => s.byProject[project.id]?.marks.length ? s.byProject[project.id] : undefined);
  // The desktop app's drops arrive as paths, routed by where the pointer is: the box takes them over the workspace,
  // which would add them to the project's media.
  const { over: dropping, dropProps } = useFileDropTarget(
    paths => attach(project.id, paths.map(path => ({ path }))),
    files => attach(project.id, Array.from(files)),
    { ignoreChildLeave: true },
  );

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
  const saveWords = async (session: typeof rewordSession, text: string) => {
    const request = session.request;
    if (!request) return;
    setError("");
    setBusy(true);
    try {
      const skillIds = await commandSkillIds(text);
      // The library may finish loading after this rewording has closed.
      if (session.request) await request.onSave(text, skillIds);
    } catch (e) {
      requestLog("send-failed", { how: "reword", task: request.id, ...failure(e) }, "warn");
      if (session.request) setError(errorMessage(e));
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

  /**
   * What a press of send is about to do, for the app log: how it was sent, where it goes and how long it is, never
   * its words. The store logs the request the engine made of it, or why it couldn't.
   */
  const sendFields = (how: string, chars: number, anchor: AgentContext | null = displayAnchor) => ({
    how, dest: question ? "answer" : replying ? "reply" : anchor ? "moment" : "new-edit", chars, aim: aimKind(anchor),
    project: project.id, thread: thread?.id, question: question?.id,
    files: useAttachmentsStore.getState().byProject[project.id]?.length || undefined,
    marks: usePictureMarksStore.getState().byProject[project.id]?.marks.length || undefined,
  });
  /** Continue the focused thread, start a note at a moment, or start a new request. */
  /** Sends the message, and says whether the files attached to it went with it. An answer to Scarlet's question carries them as any other message does. */
  const send = async (text: string, voiceTranscript?: string, anchor = displayAnchor, skillIds?: string[], files?: TaskAttachment[], drawn?: PictureMarks): Promise<boolean> => {
    const attachments = files?.length ? files : undefined;
    const carried = attachments && { attachments, ...(drawn && { pictureMarks: drawn }) };
    if (question) {
      const answer = anchor?.editNumber ? `${[`Edit ${anchor.editNumber}`, anchor.label].filter(Boolean).join(" · ")} — ${text}`
        : anchor ? `At ${anchor.markedRange || anchor.end !== undefined ? clockRange(anchor.time, anchor.end ?? anchor.time) : clock(anchor.time)}${sourceName ? ` in ${sourceName}` : ""} — ${text}` : text;
      const runWith = effective && runChoiceDiffers(question, effective) ? effective : undefined;
      if (carried) await answerTask(question.id, answer, skillIds, runWith, carried);
      else if (runWith) await answerTask(question.id, answer, skillIds, runWith);
      else await answerTask(question.id, answer, skillIds);
      return true;
    }
    if (!effective) throw new Error(unavailableReason);
    let context: Parameters<typeof createTask>[1]["context"];
    if (replying) {
      if (anchor?.changeId && ![...thread.changes, ...thread.flagged ?? []].some(c => c.id === anchor.changeId)) throw new Error("That cut or edit isn’t there any more. Open it again and resend.");
      const position = anchor && { ...requestPosition(anchor), ...stoppedAt() };
      // A revision takes no files, so one that carries some is a request in the thread, as a reply is.
      if (revising && !attachments) {
        const task = await revise(revising.id, { text, skillIds, voiceTranscript, ...assignment(effective), ...(position && { position }) });
        recordEditReview(project.id, anchor, "revise");
        if (task) recordRevision(task);
        return true;
      }
      context = { skillIds, version: head, ...position, threadId: thread.id, ...carried };
    } else if (anchor?.mediaId) {
      context = { skillIds, version: anchor.version ?? head, mediaId: anchor.mediaId, time: anchor.time, end: anchor.end, ...carried };
    } else if (anchor && attachments) {
      // A note at a moment takes no files, so a message that carries some is a request about that moment.
      context = { skillIds, version: anchor.version ?? head, time: anchor.time, end: anchor.end, clipIds: anchor.clipIds, markedRange: anchor.markedRange, ...carried };
    } else if (anchor) {
      const { task } = await createNote(project.id, { skillIds, time: anchor.time, end: anchor.end, clipIds: anchor.clipIds, text, voiceTranscript, version: anchor.version ?? head, ...assignment(effective) });
      if (task) onCreated?.(task);
      return true;
    } else {
      context = { skillIds, version: head, ...carried };
    }
    const task = await createTask(project.id, { kind: "edit", ...effective, instruction: text, voiceTranscript, context });
    // A reply stays in its thread; anything else is a new request the page goes to.
    if (replying) {
      recordEditReview(project.id, anchor, "revise");
      recordRevision(task);
    } else onCreated?.(task);
    return true;
  };
  /** A revision sent is one ⌘Z can take back, named as its tag read when it went. */
  function recordRevision(task: Task) {
    const name = targetTag && targetTag !== "Reply" && targetTag !== "Answer" ? targetTag : undefined;
    recordUndo({ kind: "revision", projectId: project.id, taskId: task.id, ...(name && { name }) });
  }
  /** The frame the editor stopped on, for a message to a cut or an edit. */
  function stoppedAt() {
    if (!pausedAt) return {};
    const { time, version, mediaId } = pausedAt;
    return { messageTime: { time, ...version && { version }, ...mediaId && { mediaId } } };
  }
  /** The files ready to go with a message, once any still being added have landed, and taking them off the line once it's out. */
  const filesFor = async () => {
    const frame = usePictureMarksStore.getState().byProject[project.id];
    const drawing = frame?.marks.length ? frame : undefined;
    if (!useAttachmentsStore.getState().byProject[project.id]?.length && !drawing) return { files: undefined, drawn: undefined, done: () => {} };
    const adding = (useAttachmentsStore.getState().byProject[project.id] ?? []).filter(a => a.state === "adding").map(a => a.key);
    const ready = await useAttachmentsStore.getState().settled(project.id);
    // A file the message waited for that couldn't be added stops the send: the words stay in the box, and its row too.
    const failed = useAttachmentsStore.getState().byProject[project.id]?.find(a => a.state === "failed" && adding.includes(a.key));
    if (failed) throw new Error(failed.error ?? "Couldn’t add it");
    const files = ready.flatMap(a => a.attachment ?? []);
    const drawn = drawing && await sendMarks(project.id, drawing);
    if (drawn) files.push(drawn.attachment);
    return { files, drawn: drawn?.marks, done: (carried: boolean) => {
      if (!carried) return;
      useAttachmentsStore.getState().sent(project.id, ready.map(a => a.key));
      // Marks changed while the message went out stay for the next one.
      if (drawing && usePictureMarksStore.getState().byProject[project.id] === drawing) usePictureMarksStore.getState().clear(project.id);
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
      const held = !words ? "empty" : busy ? "still-sending" : speech.busy ? "listening" : undefined;
      if (held) requestLog("send-ignored", { how: "reword", reason: held, task: rewording.id });
      else {
        requestLog("send", { how: "reword", task: rewording.id, chars: words.length });
        await saveWords(rewordSession, words);
      }
      return;
    }
    const text = draft.trim();
    // Enter with nothing it can send does nothing on screen. The log says which, so a message that seemed to go
    // nowhere can be told from one that went.
    const ignored = !text ? "empty" : text === "/" ? "slash-only" : onlyTime ? "time-only" : busy ? "still-sending" : speech.busy ? "listening" : undefined;
    if (ignored) return requestLog("send-ignored", { reason: ignored, ...sendFields("typed", text.length) });
    // Nothing can take the message. Enter says why under the box, where it used to do nothing.
    if (unavailable) {
      requestLog("send-refused", { reason: "no-model", why: unavailableReason, ...sendFields("typed", text.length) }, "warn");
      return setRefused(true);
    }
    requestLog("send", sendFields("typed", text.length));
    setError("");
    setRefused(false);
    setBusy(true);
    try {
      const skillIds = await commandSkillIds(draft);
      const { files, drawn, done } = await filesFor();
      done(await send(text, undefined, displayAnchor, skillIds, files, drawn));
      clearSentDraft(owner, { agentDraft: draft, agentContext: context });
      if (boxIsFree()) onSent?.();
    } catch (e) {
      // The words stay in the box, with the reason under it.
      requestLog("send-failed", { how: "typed", chars: text.length, ...failure(e) }, "warn");
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
    // Said while the box held a queued request's words: what was said takes their place in the box, and waits there
    // as typed words do. The tick saves it and Esc leaves the request as it was. Words the editor put back meanwhile
    // stay as they were, and what was said for them is not sent as a new request.
    if (voiceReword.current) {
      voiceReword.current.request?.onChange(text);
      inputRef.current?.focus();
      return;
    }
    const anchor = voiceAnchor.current === undefined ? displayAnchor : voiceAnchor.current;
    requestLog("send", sendFields("voice", text.length, anchor));
    try {
      const { files, drawn, done } = await filesFor();
      done(await send(text, text, anchor, undefined, files, drawn));
    } catch (e) {
      requestLog("send-failed", { how: "voice", chars: text.length, ...failure(e) }, "warn");
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
      // A note at a moment takes no files or picture marks, so a spoken message that carries any goes through send as a request.
      const carriesFiles = Boolean(
        useAttachmentsStore.getState().byProject[project.id]?.some(a => a.state !== "failed")
        || usePictureMarksStore.getState().byProject[project.id]?.marks.length,
      );
      if (voiceReword.current || replying || !anchor || anchor.mediaId || !effective || carriesFiles) return await speech.handle(r);
      requestLog("send", { ...sendFields("voice-note", 0, anchor), bytes: r.blob.size });
      setBusy(true);
      try {
        const { task } = await createVoiceNote(project.id, r.blob, { time: anchor.time, end: anchor.end, clipIds: anchor.clipIds, version: anchor.version ?? head, ...assignment(effective) });
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
  // A time alone says where but not what: there is nothing to send until words follow it.
  const onlyTime = !rewording && times.length === 1 && value.trim() === times[0]!.text;
  useLayoutEffect(() => {
    if (rewording || replying || !aimsByText) return;
    if (typedPoint && !sameClock && messageTimestamps(value, Infinity).some(t => t.time === typedPoint.time)) return;
    if (inputClock && firstTime !== undefined) {
      // A clock in whole seconds covers the moment it names to the frame.
      if (sameClock && typedPoint && (firstTime === typedPoint.time || (!times[0]!.text.includes(".") && Math.floor(typedPoint.time) === firstTime))) return;
      setContext({ ...editTargetAt(firstTime, inputClock.version, inputClock.timeline, inputClock.mediaId), fromMessage: true });
    } else if (typedPoint) setContext(null);
  }, [value, firstTime, inputClock, typedPoint, sameClock, rewording, replying, aimsByText, setContext]);
  const tagWords = targetTag && lowerFirst(targetTag);
  // What the tag's message does, for its hover note: a cut or an edit is revised, a question answered, an edit replied to.
  const answerNote = question && targetTag === "Answer" ? targetTagNote : undefined;
  const tagAct = !targetTag ? undefined : question && targetTag === "Answer" ? answerNote ? `Answering question ${answerNote}. The next follows once this is sent.` : "Answering Scarlet’s question"
    : thread && targetTag === "Reply" ? "Replying to this edit" : `Revising ${tagWords === "whole edit" ? "the whole edit" : tagWords}`;
  // What taking the tag off says it does instead.
  const newEditInstead = tagAct && `Start a new edit instead of ${lowerFirst(tagAct)}`;
  const tag = rewording ? undefined : targetTag;
  // A stretch marked on the timeline's ruler rides with the message, beside the tag of the cut or edit it is aimed at.
  // Words chosen in the transcript ("Ask about this") for a new edit show the same Range tag so the box names them and can take them off.
  const marked = rewording ? undefined : markedRangeOf(context);
  const chosenRange = !rewording && !marked && context && context !== "whole" && !context.changeId && context.end !== undefined
    ? { start: context.time, end: context.end } : undefined;
  const shownRange = marked ?? chosenRange;
  const rangeWords = shownRange ? preciseRange(shownRange.start, shownRange.end) : "";
  const rangePrecise = shownRange ? `${playbackClock(shownRange.start)} – ${playbackClock(shownRange.end)}` : "";
  // "Answer" and "Reply" name who the message goes to. The target label shows the place it is about.
  const wordTag = tag === "Answer" || tag === "Reply" ? tag : undefined;
  const placeTag = wordTag ? undefined : tag;
  const takeOffTarget = () => {
    if (onClearTarget) onClearTarget(); else setContext("whole");
    inputRef.current?.focus();
  };
  // The marked or transcript range Backspace or its × just took off the box, and what that left the box aimed at. ⌘Z in the empty box
  // puts the range back, until the box is aimed again, written in or spoken into.
  const rangeTakenOff = useRef<{ was: AgentContext; left: AgentContext | null }>(undefined);
  /** Takes the marked or transcript range off the message, and says what the box was aimed at and what that leaves. */
  const takeOffRange = () => {
    const was = context && context !== "whole" ? context : undefined;
    const left = withMarkedRange(context, undefined);
    setContext(left, was?.changeId ? was : undefined);
    return was && { was, left };
  };
  useEffect(() => {
    if (rangeTakenOff.current && rangeTakenOff.current.left !== context) rangeTakenOff.current = undefined;
  }, [context]);
  const restoreRange = () => {
    const taken = rangeTakenOff.current;
    rangeTakenOff.current = undefined;
    if (!taken) return false;
    setContext(taken.was);
    return true;
  };
  // Paused with a cut or an edit open, the header shows the one time the editor is looking at: where they stopped.
  // Its full name on hover still says which cut or edit the message goes to.
  const stopped = replying && !targetIsPoint && pausedAt && aimTime === undefined ? clock(pausedAt.time) : undefined;
  const exactTime = targetTime !== undefined ? targetTime
    : displayAnchor && placeTag && (placeTag.endsWith(` at ${clock(displayAnchor.time)}`) || placeTag === `At ${clock(displayAnchor.time)}`)
      ? displayAnchor.time : undefined;
  const exactClock = exactTime !== undefined ? playbackClock(exactTime) : displayAnchor ? playbackClock(displayAnchor.time) : undefined;
  const placeDisplay: ReactNode = (() => {
    if (!placeTag) return undefined;
    if (targetIsPoint) {
      const time = placeTag.replace(/^At /, "");
      return <><span className="composer-aim-verb">At</span> <AimTimecode key={`pt:${placeTag}:${exactClock ?? ""}`} value={time} precise={exactClock} /></>;
    }
    if (/^(?:Cut|Edit) \d+$/.test(placeTag)) {
      return aimTime !== undefined
        ? <><span className="composer-aim-target">{placeTag}</span> <span className="composer-aim-sep" aria-hidden="true">·</span> <AimTimecode key={`call:${placeTag}:${aimTime}`} value={clock(aimTime)} precise={playbackClock(aimTime)} /></>
        : <span className="composer-aim-target">{placeTag}</span>;
    }
    const timed = /^(Cut|Edit|\d+ edits) at (.+)$/.exec(placeTag);
    if (timed) {
      const noun = timed[1]!;
      const time = stopped ?? timed[2]!;
      const exact = stopped && pausedAt ? playbackClock(pausedAt.time) : exactClock;
      return <><span className="composer-aim-verb">{noun}</span> <AimTimecode key={`edit:${placeTag}:${exact ?? time}`} value={time} precise={exact} /></>;
    }
    return <span className="composer-aim-verb">{placeTag}</span>;
  })();
  const placeName = placeTag
    ? targetIsPoint ? placeTag.replace(/^At /, "") : stopped ? `${placeTag}, stopped at ${stopped}` : placeTag
    : undefined;
  const aimItem: AimItem | undefined = shownRange ? {
    key: `range:${shownRange.start}/${shownRange.end}`,
    name: `Range ${rangeWords}`,
    displayName: <><span className="composer-aim-verb">Range</span> <AimTimecode key={`range:${shownRange.start}/${shownRange.end}`} value={rangeWords} precise={rangePrecise} /></>,
    clearLabel: marked ? `Take the marked range ${rangeWords} off the message` : `Take the range ${rangeWords} off the message`,
    onClear: () => {
      const taken = takeOffRange();
      // Taken off a box with words in it, the range isn't ⌘Z's to put back: the words keep their own ⌘Z.
      rangeTakenOff.current = draft.trim() ? undefined : taken;
      inputRef.current?.focus();
    },
  } : placeTag ? {
    key: `target:${placeTag}`,
    name: placeName!,
    displayName: placeDisplay,
    title: `About ${placeName}`,
    clearLabel: targetIsPoint ? `Take “${placeTag}” off: the message is about the whole video` : newEditInstead!,
    onClear: takeOffTarget,
  } : undefined;
  const saveLabel = rewording ? "Save the new words" : sendLabel;
  function changeText(text: string) {
    dismissFirstEditHint();
    setError("");
    if (rewording) return rewording.onChange(text);
    if (text.trim()) {
      rangeTakenOff.current = undefined;
      captureTarget();
    } else if (context && context !== "whole" && playheadPoints.has(context)) setContext(null);
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
      {/* Where the message goes (a cut, an edit, a moment, a stretch marked on the ruler) is a flush context header
          on top of the box, under the queue's tray, so the box keeps its whole width for the words. */}
      {aimItem && <div className="composer-aim-line">
        <ComposerAim item={aimItem} disabled={recording || heard} disabledReason="Waits until what you’re saying is sent" />
      </div>}
      {(attached.length > 0 || markedFrame) && <AttachedFiles files={attached} onRemove={key => { detach(project.id, key); inputRef.current?.focus(); }}
        marked={markedFrame} onOpenMarked={frame => {
          player.pause();
          player.seek(frame.time, true);
          if (usePictureMarksStore.getState().marking !== project.id) toggleMarking(project.id, frame);
        }} onRemoveMarked={() => { usePictureMarksStore.getState().clear(project.id); inputRef.current?.focus(); }} />}
      {/* Esc leaves a queued request's words as they were, unless the skill list took it first. */}
      {/* While an input method composes, Esc is its own: it puts away its candidates, and the words stay in the box. */}
      {/* Backspace in an empty box takes the tag off, as its × does, and ⌘Z puts it back. A held Backspace that just emptied the box doesn't. */}
      <div className={firstEditHint ? "composer-box first-edit-hint" : "composer-box"} onKeyDown={e => {
        if (rewording && e.key === "Escape" && !e.defaultPrevented && !isComposing(e)) rewording.onCancel();
        const emptyBox = !e.defaultPrevented && !isComposing(e) && !recording && !heard && e.target === inputRef.current && !inputRef.current.value;
        // Esc or Option/Alt+X in an empty box takes a range off at once, as they do elsewhere on the page. A popover
        // that is open takes its own Esc first.
        if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && emptyBox && shownRange && !document.querySelector("[data-escape-owner]")) takeOffRange();
        if (isAltClearRangeKey(e) && emptyBox && shownRange && !document.querySelector("[data-escape-owner]")) {
          e.preventDefault();
          rangeTakenOff.current = takeOffRange();
        }
        if ((e.key === "Backspace" || (e.key === "Delete" && shownRange)) && !e.repeat && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && emptyBox && (aimItem || wordTag)) {
          e.preventDefault();
          // "Answer" and "Reply" come off as their own × takes them off.
          if (aimItem) aimItem.onClear(); else takeOffTarget();
        }
        if (e.key.toLowerCase() === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && emptyBox && !rewording && (restoreRange() || onRestoreTarget?.())) {
          e.preventDefault();
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
          {wordTag && <span className="composer-tag" title={tagAct}>
            <span className="composer-tag-name">{wordTag}</span>
            {wordTag === "Answer" && answerNote && <span className="composer-tag-note">{answerNote}</span>}
            {/* A spoken message stays where it was said until it is out: aiming the box elsewhere would drop it. */}
            <button type="button" className="composer-tag-clear" disabled={recording || heard}
              aria-label={newEditInstead}
              title={recording || heard ? "Waits until what you’re saying is sent" : "New edit instead"} onClick={takeOffTarget}><Icon name="x" size={10} /></button>
          </span>}
          <SkillCommandInput key={owner} id={inputId} inputRef={inputRef} value={value} skills={skills}
            placeholder={rewording ? "What should it ask instead?" : question ? "Answer Scarlet…" : displayAnchor?.changeId && context ? (stopped ? "What should change at this frame?" : placeTag ? "What should change here?" : "What should change?") : replying ? "Write a follow-up…" : NEW_EDIT_HINT}
            timestamps={sameClock ? times : undefined} onTimestamp={inputClock?.seek} onChange={changeText} onSubmit={() => void submitText()} />
          {/* The reason is only for a mic with no agent to talk to. While a message sends or is written down the spinner says why. */}
          <MicButton onResult={(r) => void onVoice(r)} onStart={() => {
            dismissFirstEditHint();
            setError("");
            rangeTakenOff.current = undefined;
            voiceReword.current = rewording ? rewordSession : undefined;
            if (!voiceReword.current) voiceAnchor.current = captureTarget();
          }} onRecording={setRecording} onError={setError} followHold disabled={unavailable || busy || speech.busy} disabledReason={unavailable ? unavailableReason : undefined} label="Talk to Scarlet" />
          {(busy || speech.busy) && <Spinner className="size-3.5 shrink-0" />}
          {/* Shown once there's something to send (Enter sends too). Stopping an edit is on its card, where its progress is. */}
          {value.trim() && !onlyTime && <button type="button" className={rewording ? "btn-primary composer-send is-save shrink-0" : "btn-primary composer-send shrink-0"} data-log-control={rewording ? "save-queued-request" : "send-request"} aria-label={saveLabel} title={saveLabel}
            disabled={busy || speech.busy || (!rewording && (draft.trim() === "/" || unavailable))} onClick={() => void submitText()}>
            <Icon name={rewording ? "check" : "arrow"} size={15} />
          </button>}
        </div>
      </div>
    </div>
  );

  // Files dropped on the box attach to the message. Dropped anywhere else in the workspace, they're added to the project.
  return <div {...dropProps} className={none ? "composer-dock needs-agent" : "composer-dock"}>
    <InlineError>{error || (refused && unavailable && unavailableReason)}</InlineError>
    {editor}
    {dropping && <div className="composer-drop" aria-hidden="true">Attach to your message</div>}
  </div>;
}

/** What the empty box says when the message would start a new edit. */
export const NEW_EDIT_HINT = "Describe an edit, / skills";
