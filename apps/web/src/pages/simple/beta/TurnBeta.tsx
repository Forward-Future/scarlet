import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import type { Change } from "@scarlet/timeline";
import { closingCheckFailed, isProjectEditTask, matchesEdit, requestTargetKey, requestText, type Learning, type Task, type ThreadEdit } from "@scarlet/shared";
import { useAgentAvailability } from "../../../components/agent/AgentChip";
import { RequestMetrics, RunBundle, runEnded, Said } from "../../../components/review/RunBundle";
import { useReviewed, useRevising, useThreadEdits } from "../../../components/review/threadEditState";
import { Icon } from "../../../components/ui/primitives";
import { TipButton } from "../../../components/ui/TipButton";
import { errorMessage } from "../../../lib/client";
import { clock as clockLabel, parseTimestamp } from "../../../lib/format";
import { editKey } from "../../../lib/keptEdits";
import { markedFrameUrl } from "../../../lib/markedFramePictures";
import { isDialoguePass, isOpenPass, openPass, waitsToPlay } from "../../../lib/passCalls";
import { ReviewLinger } from "./reviewTabsBeta";
import { aboutOne, aimOf, closingReply, notesStillAsked, threadRuns, waitingToStart, type Run } from "../../../lib/requestRuns";
import { runAim, runIsActive, spentLabel } from "../../../lib/taskRun";
import { firstCutDeliveries, isRecheck, isRedo, RECHECK_WORDS, requestTarget, revisionTarget, threadConversation, type Thread, type ThreadEntry } from "../../../lib/threads";
import { useNearView } from "../../../lib/useNearView";
import { useProjectStore } from "../../../stores/project";
import { useSkillsStore } from "../../../stores/skills";
import { useUiStore } from "../../../stores/ui";
import { PassSummary, ThreadResult } from "./PassSummaryBeta";
import { useReviewRail } from "../railStore";
import { callRowKey, isWorking, letGo, noop, PAUSED_HINT, tagOf, type ChatActions, type Nest, type PassList, type ReportReviewMarkers } from "../types";

/** What the chat says of how a run ended that a request's block doesn't read out: its heading says it stopped or couldn't finish. */
const UNSAID = /^(?:Edit stopped\.|Edit resumed\.|Scarlet couldn’t finish this edit\.)$/;

/** "Learned for dialogue-pass: ". What the rule came from ("from 3 cuts you rejected") is said in Learnings, not on the chat's one line. */
function learnedLead(skill: string | undefined): string {
  return skill ? `Learned for ${skill}: ` : "Learned: ";
}

/**
 * A rule Scarlet picked up from this request, under what the request did, on one line: the skill it is for and the rule
 * in quotes, cut short with an ellipsis when long and whole on hover, then Review, which opens Learnings at it, and
 * Decline, which turns the rule down from here. The line goes once the editor decides, here or in Learnings.
 */
function LearnedLine({ learning, onReview }: { learning: Learning; onReview?(id: string): void }) {
  const skill = useSkillsStore(s => s.skills.find(k => k.id === learning.skillId)?.name);
  // The line names the skill, so the library is read once if nothing has read it yet. A read that failed isn't asked
  // again from here: the line says "Learned:" without the name, and Learnings tries again as it opens.
  const loadSkills = useSkillsStore(s => s.load);
  useEffect(() => { if (useSkillsStore.getState().status === "idle") void loadSkills(); }, [loadSkills]);
  const [declining, setDeclining] = useState(false);
  const [failed, setFailed] = useState("");
  const decline = () => {
    setDeclining(true);
    setFailed("");
    useProjectStore.getState().declineLearning(learning.id)
      .catch(e => setFailed(errorMessage(e)))
      .finally(() => setDeclining(false));
  };
  return <p className="simple-learned">
    <Icon name="bulb" size={13} />
    <span className="simple-learned-line"><span className="simple-learned-lead">{learnedLead(skill)}</span>
      <span className="simple-learned-rule" title={learning.rule}>“{learning.rule}”</span>
      {onReview && <>{" "}<button type="button" className="simple-learned-review" onClick={() => onReview(learning.id)}
        title="Approve or revise it in Learnings">Review</button></>}
      {" "}<button type="button" className="simple-learned-decline" disabled={declining} onClick={decline}
        title="Don't learn this">Decline</button></span>
    {failed && <span className="simple-learned-failed" role="alert">Couldn't decline. {failed}</span>}
  </p>;
}

/** The frame the editor drew on for a request, with their marks, before their words in its band. */
function MarkedFrameOnRequest({ projectId, task }: { projectId: string; task: Task }) {
  const drawn = task.context.pictureMarks;
  if (!drawn) return null;
  const count = drawn.marks.length;
  return <img className="unit-marked-frame" src={markedFrameUrl(projectId, drawn.attachmentId)} alt=""
    title={`Marked frame ${clockLabel(drawn.time)} · ${count === 1 ? "1 mark" : `${count} marks`}`} />;
}

/**
 * Scarlet's words about a change. Applied edits are listed once for the whole thread, after the last reply,
 * so a reply carries only what needs the editor and, for a proposal, how to play it.
 */
function ChangeReply({ thread, entry, actions }: { thread: Thread; entry: Extract<ThreadEntry, { kind: "change" }>; actions: ChatActions }) {
  const { change } = entry;
  const pending = waitsToPlay(change, thread);
  // A dialogue pass's calls are counted on the thread's summary card and made in the card on the timeline.
  const pass = pending && isDialoguePass(change);
  const reviewing = actions.reviewingId === change.id;
  return <div className="simple-msg from-scarlet">
    <span className="simple-who">Scarlet</span>
    {/* A suggestion still waiting has no Play link under it: its one line is the control, led by the play mark. */}
    {pending && !pass ? <button type="button" className={reviewing ? "simple-suggest is-on" : "simple-suggest"} aria-pressed={reviewing}
      title={reviewing ? "Stop showing this suggestion" : "Play this suggestion"} onClick={letGo(() => reviewing ? actions.stopShowing() : actions.review(change))}>
      <Icon name="play" size={11} /><span title={entry.text}>{entry.text}</span></button> : <Said text={entry.text} />}
  </div>;
}

/**
 * One thread's requests. Each is the editor's message, then what Scarlet is doing about it or what it made. The request
 * Scarlet is on now, or the pass waiting on the editor's calls, is `pinned`: it draws above the message box, in
 * `pinHost`, and takes its place in the chat when it's done. A request still waiting its turn isn't here at all; it's in
 * the tray on the message box.
 */
export function Turn({ projectId, thread, threadOrder = 0, actions, pinned, pinHost, list: passList, reportReviewMarkers, reportEvery, askingRowKey }: { projectId: string; thread: Thread; threadOrder?: number; actions: ChatActions; pinned?: string; pinHost: HTMLElement | null;
  reportReviewMarkers?: ReportReviewMarkers;
  /** With no request picked the timeline marks every request's edits, so this one reports them all, not only the ones that wait. */
  reportEvery?: boolean;
  /** Which of this request's lists is open. */
  list: PassList;
  /** The row key whose question is currently displayed over the message box, so it lights up. */
  askingRowKey?: string }) {
  const rail = useReviewRail();
  const notes = useProjectStore(s => s.current?.notes ?? []);
  // Only this thread's runs: every streamed event replaces the project's map, and this thread rebuilds only for its own.
  const events = useProjectStore(useShallow(s => Object.fromEntries(thread.tasks.flatMap(t => {
    const own = s.current?.taskEvents[t.id];
    return own ? [[t.id, own] as const] : [];
  }))));
  // The attempts whose whole history is here, not only what was said in them.
  const wholeHistory = useProjectStore(useShallow(s => thread.tasks.flatMap(t => s.current?.taskEventScopes?.[t.id] === "all" ? [t.id] : [])));
  const loadTaskEvents = useProjectStore(s => s.loadTaskEvents);
  const cancelTask = useProjectStore(s => s.cancelTask);
  const editingPaused = useProjectStore(s => s.current?.id === projectId && s.current.project.editingPaused);
  const retryRun = useProjectStore(s => s.retryTask);
  // Retry and Resume run on the model picked now, which may not be the one that failed.
  const { effective } = useAgentAvailability();
  const retryTask = (taskId: string) => retryRun(taskId, effective ?? undefined);
  const continueWhenReady = useProjectStore(s => s.continueWhenReady);
  const allTasks = useProjectStore(s => s.current?.tasks ?? []);
  // The tokens each run reported, while those show (Settings → Usage).
  const showTokens = useUiStore(s => s.showRunTokens);
  const usage = useProjectStore(s => showTokens ? s.current?.taskUsage : undefined);
  // The changes a request about one cut or edit can name, to tell which edit it is across its revisions (`requestTargetKey`).
  const threadChanges = useMemo(() => [...thread.changes, ...thread.flagged ?? []], [thread.changes, thread.flagged]);
  const historyKey = useMemo(() => JSON.stringify(thread.tasks.filter(t => !waitingToStart(t)).map(t => [t.id, runIsActive(t)])), [thread.tasks]);
  useEffect(() => {
    const scopes = useProjectStore.getState().current?.taskEventScopes;
    // The requests Scarlet has picked up again under a new attempt. What it opened one with is in the history of the
    // attempts before, among their tool events.
    const pickedUp = new Set(thread.tasks.flatMap(t => t.resumeRootId && runIsActive(t) && !waitingToStart(t) ? [t.resumeRootId] : []));
    for (const task of thread.tasks) {
      if (waitingToStart(task)) continue;
      // Live activity and an open question can use tool events. Finished requests keep their conversation and result.
      const scope = runIsActive(task) || pickedUp.has(task.resumeRootId ?? task.id) ? "all" : "conversation";
      if (scopes?.[task.id] !== "all" && scopes?.[task.id] !== scope) void loadTaskEvents(task.id, scope).catch(noop);
    }
  }, [historyKey, loadTaskEvents]); // eslint-disable-line react-hooks/exhaustive-deps
  const firstCuts = useMemo(() => firstCutDeliveries(thread), [thread]);
  // A request's list is read again for each new working cut only while it is used: in the chat's view, above the
  // message box, open, on the timeline, or carrying an edit that asks for a look, which the timeline marks from this
  // list. Out of view it keeps its last list until it comes back.
  const section = useRef<HTMLElement>(null);
  const inView = useNearView(section, ".simple-chat");
  const asksForALook = useRef(false);
  const { listed, rejected, located, settled: listLoaded, head } = useThreadEdits(projectId, thread, inView || !!passList[0] || actions.marked === thread.id
    || (!!pinned && thread.tasks.some(t => t.id === pinned)) || !!rail || (!!reportReviewMarkers && (!!reportEvery || asksForALook.current)));
  asksForALook.current = listed.some(edit => !!edit.check);
  const reviewed = useReviewed(projectId, thread);
  const revising = useRevising(thread);
  useEffect(() => {
    if (!reportReviewMarkers || !located) return;
    const waits = (edit: ThreadEdit) => !!edit.check && !reviewed(edit) && !revising(edit);
    const reported = reportEvery ? located : located.filter(waits);
    if (!reported.length) return;
    const markers = reported.map(edit => ({ edit,
      state: reviewed(edit) ? "kept" as const : waits(edit) ? "check" as const : undefined }));
    reportReviewMarkers(thread.id, { head, markers });
    return () => reportReviewMarkers(thread.id);
  }, [thread.id, head, located, rejected, reviewed, revising, reportReviewMarkers, reportEvery, rail]);
  // A thread with a dialogue pass sums it up on one line instead of listing every cut.
  const waitingPass = openPass(thread, allTasks);
  const pendingPass = !!waitingPass;
  const passTasks = useMemo(() => new Set([...firstCuts.keys()]), [firstCuts]);
  const hasDecidedCalls = thread.changes.some(c => c.state === "approved" && !!c.cutChoices?.length);
  const summed = passTasks.size > 0 || pendingPass || hasDecidedCalls;
  const { entries } = useMemo(() => threadConversation(thread, notesStillAsked(notes, allTasks), events, firstCuts), [thread, notes, allTasks, events, firstCuts]);
  // Why a press on one of this thread's requests failed (Stop, Resume, Retry), and which request. The line is that
  // request's own: it reads at the end of its block and goes where the block goes, above the message box too.
  const [failed, setFailed] = useState<{ run: string; text: string }>();
  // The calls listed in the pass's open list. Held here and not on the pass's line: a request that moves between the
  // conversation and the place above the message box is mounted anew, and a list the editor opened must not close by
  // itself then. Which list is open is held by the workspace, for the same reason.
  const passListed = useRef(new Set<string>());
  // Whether one of the request's edits was open when its line last drew, and which.
  const wasShowing = useRef(false);
  const lastOpen = useRef<string>(undefined);
  // The rows the editor has just decided or sent back, which stay in For you a moment before they leave.
  const [linger] = useState(() => new ReviewLinger());
  useEffect(() => () => linger.dispose(), [linger]);
  // Edits saved along the way belong to their run. Only the run's last edit is a result to Play, Revise or Undo.
  const { finals, folded } = useMemo(() => {
    const finals = new Map<string, Change | undefined>();
    const folded = new Set<string>();
    for (const t of thread.tasks) {
      const own = thread.changes.filter(c => c.taskId === t.id || t.changeIds.includes(c.id));
      const final = runIsActive(t) ? undefined : own.at(-1);
      finals.set(t.id, final);
      for (const c of own) if (c !== final && c.state !== "ready") folded.add(c.id);
    }
    // A proposal whose revision already arrived isn't still "being revised". The revision below replaces it.
    for (const c of thread.changes) {
      if (c.state === "revising" && thread.changes.some(r => r.taskId && thread.tasks.some(t => t.id === r.taskId && t.context.changeId === c.id)))
        folded.add(c.id);
    }
    return { finals, folded };
  }, [thread]);
  const runs = useMemo(() => threadRuns(thread), [thread]);
  const runOf = new Map(runs.flatMap(run => run.attempts.map(t => [t.id, run] as const)));
  // What a request made. An attempt that picks it up after a pause or a restart starts with no change of its own:
  // what the attempts before it saved is still what the request made.
  const finalOf = (run: Run) => {
    if (runIsActive(run.task)) return undefined;
    for (let i = run.attempts.length - 1; i >= 0; i--) {
      const attempt = run.attempts[i]!, final = finals.get(attempt.id);
      if (final || !attempt.resumeRootId) return final;
    }
    return undefined;
  };
  // The rules this thread's requests taught Scarlet that still wait on the editor's call.
  const learned = useProjectStore(useShallow(s => (s.current?.learnings ?? []).filter(l => l.state === "suggested" && runOf.has(l.taskId))));
  // The thread's edits list on the card of the run that made them: the dialogue pass, else the first request. A
  // request about one cut never holds the pass: when its revision is the latest proposal, the pass stays on the card
  // of the request that asked for it, and the revision's card says what it did to its cut.
  const owner = runs.find(run => run.attempts.some(t => passTasks.has(t.id)))
    ?? (pendingPass ? runs.find(run => !aboutOne(run) && run.attempts.some(t => t.id === waitingPass?.taskId)) ?? runs.find(run => !aboutOne(run)) : undefined)
    ?? runs[0];
  // A rejected edit keeps its row, also when it was the request's only edit: nothing else says it was rejected (2026-11-23).
  const hasRows = listed.length > 0 || rejected.length > 0 || (summed && (actions.pass?.threadId === thread.id || (listLoaded && hasDecidedCalls)));
  // With no line for the pass (it was thrown away), its list is closed: a pass staged again starts folded. A pass that
  // went in leaves the thread's edits, and the list of those still waiting on the editor stays open: their place in
  // the chat must not go with the calls (2026-11-16).
  const passLine = summed && hasRows;
  // Only when the line goes: a list kept open across a restart is drawn before its rows have loaded, and stays open.
  const hadPassLine = useRef(passLine);
  useEffect(() => {
    if (hadPassLine.current && !passLine) passList[1](open => open !== "all" && hasRows ? open : undefined);
    hadPassLine.current = passLine;
  }, [passLine]); // eslint-disable-line react-hooks/exhaustive-deps
  // Each press starts clean: the last failure's line doesn't stay under a request once the same action works.
  const attempt = (run: string, job: Promise<unknown>) => { setFailed(undefined); void job.catch(e => setFailed({ run, text: errorMessage(e) })); };
  // Nor once the request has moved on by itself: a Stop refused because the run had just ended has nothing left to press.
  const runStates = thread.tasks.map(t => `${t.id}:${t.state}`).join();
  useEffect(() => setFailed(undefined), [runStates]);

  /** Something that belongs to no run: a note left on a change, a decision the engine recorded. Part of the request's own conversation. */
  const loose = (entry: ThreadEntry, i: number) => {
    switch (entry.kind) {
      // The editor's words keep to two lines, as a request's do, and a click opens the rest.
      case "request":
        return <div key={i} className="simple-msg from-you"><span className="simple-who">You</span>
          {entry.revisionLabel && <span className="simple-revising">{tagOf(tagFor(entry) ?? entry.revisionLabel)}</span>}<Said text={entry.text} /></div>;
      case "answer":
        return <div key={i} className="simple-msg from-you"><span className="simple-who">You</span><Said text={entry.text} /></div>;
      case "agent":
        return <div key={i} className="simple-msg from-scarlet"><span className="simple-who">Scarlet</span><Said text={entry.fullText ?? entry.text} /></div>;
      case "change":
        // An applied change with no request behind it says what it did once: in the sentence over its edits.
        if (entry.change.state === "approved" && (hasRows || !listLoaded)) return null;
        return <ChangeReply key={i} thread={thread} entry={entry} actions={actions} />;
      case "system":
        return <div key={i} className={`simple-note${entry.tone === "bad" ? " is-bad" : ""}`}>{entry.text}</div>;
      default:
        return null;
    }
  };

  // A request's tag names its edit as the list does: the engine's list knows where each edit sits in the cut now.
  const tagFor = (entry: ThreadEntry) => {
    const asked = entry.taskId ? thread.tasks.find(t => t.id === entry.taskId) : undefined;
    return asked && revisionTarget(asked, thread.changes, everyEdit);
  };
  // Every edit with a row, rejected ones too: Scarlet's put-back of an edit marks it rejected as soon as it saves, and
  // the request that asked for it, still checking its joins, stays under that row rather than in a block of its own.
  const everyEdit = useMemo(() => rejected.length ? [...listed, ...rejected] : listed, [listed, rejected]);
  // The one cut or edit each request was about.
  const targets = new Map(runs.map(run => [run.root, run !== owner ? requestTarget(aimOf(run), finalOf(run), thread.changes, everyEdit, thread.tasks) : undefined] as const));

  // The cut or edit a request is about, as its row's key, whether or not that row is listed now: an applied edit, or a
  // call of the pass that waits.
  const subject = (run: Run) => {
    const target = targets.get(run.root);
    if (target?.edit) return editKey(target.edit);
    return target?.call !== undefined && target.changeId === waitingPass?.id ? `call/${target.call}` : undefined;
  };
  // A request that stopped early is overtaken once Scarlet has begun a later request about the same cut or edit, or the
  // pass it was a call of has been applied or put away. Picking it up again would then work on something already asked
  // again or settled. A call on its cut alone doesn't take it away: nothing records when a call was made, so one made
  // before the cut was sent back reads the same as one made since, and a revision of an approved cut that couldn't
  // finish would leave without a word (2026-11-09).
  const overtaken = (run: Run) => {
    const { cutIndex } = aimOf(run).context, about = subject(run), aim = requestTargetKey(aimOf(run), threadChanges);
    const later = runs.some(other => other !== run && other !== owner && aboutOne(other) && parseTimestamp(other.attempts[0]!.createdAt) > parseTimestamp(run.task.createdAt)
      && ((!!about && subject(other) === about) || (!!aim && requestTargetKey(aimOf(other), threadChanges) === aim)));
    if (later || cutIndex === undefined) return later;
    const target = targets.get(run.root);
    if (target?.edit) return true;
    const version = target?.call !== undefined ? thread.changes.find(c => c.id === target.changeId) : undefined;
    return !!version && (version.state === "approved" || (version.state === "rejected" && !version.replacedBy));
  };

  // A request about one cut or edit leaves the conversation once it's done: what it did is on that cut or edit, in its
  // list and on its card. One that stopped early, or left a suggestion to play, stays with its one action. So does one
  // that changed nothing and said why, or whose new version couldn't be prepared: Scarlet's words are the only place
  // that says so. One that stopped early leaves once it is overtaken: left there it would have no action to offer.
  const settled = (run: Run) => {
    if (run === owner || !aboutOne(run) || pinned === run.root) return false;
    if (run.task.state === "cancelled" || run.task.state === "failed") return overtaken(run);
    // One paused for its transcripts ended as done, and stopped early all the same: it stays, with its way to finish.
    if (run.task.state !== "done" || !!runEnded(run.task) || (listLoaded && !targets.get(run.root))) return false;
    const final = finalOf(run);
    // Done with no change and not a word from Scarlet: there is nothing for it to say by staying. That an attempt
    // stopped and was picked up again is no word of Scarlet's: of those lines only the last attempt's own reason reads.
    if (!final) return !entries.some(e => e.kind === "system" ? e.taskId === run.task.id && !UNSAID.test(e.text)
      : (e.kind === "agent" || e.kind === "question") && !!e.taskId && run.attempts.some(t => t.id === e.taskId));
    // A version that couldn't be prepared changed nothing either, and only Scarlet's words here say so. Nor has a
    // suggestion Scarlet is to make again changed anything yet: the request stays to say so while that redo waits.
    if (final.state === "failed" || thread.tasks.some(t => isRedo(t) && runIsActive(t) && t.context.changeId === final.id)) return false;
    return !(final.state === "ready" && !isOpenPass(final, allTasks));
  };
  // While such a request is still in the chat it sits inside the block that lists its cut or edit, directly under that
  // row: this is the row's key for each. With nothing listed, or no row for it, it keeps a block of its own.
  const rowOf = (run: Run) => {
    const target = targets.get(run.root);
    if (target?.edit) return editKey(target.edit);
    const open = actions.pass?.threadId === thread.id ? actions.pass : undefined;
    const call = open?.calls.find(c => !!c.run && run.attempts.some(t => t.id === c.run!.id))
      ?? (target?.call !== undefined && target.changeId === open?.change.id ? open?.calls.find(c => c.index === target.call) : undefined);
    return call && callRowKey(call);
  };
  const nested = new Map(owner && hasRows ? runs.flatMap(run => {
    const key = run !== owner && aboutOne(run) && !settled(run) ? rowOf(run) : undefined;
    return key ? [[run.root, key] as const] : [];
  }) : []);
  // What the requests about each listed cut or edit took: their active time and, when those show, tokens. A request
  // about one cut or edit leaves the chat once it's done, and its figures went with it; the word its row ends on
  // (v2, Kept, Revising…) says them on hover.
  const spent = new Map<string, string>();
  if (owner && hasRows) {
    const about = new Map<string, Task[]>();
    for (const run of runs) {
      const key = run !== owner && aboutOne(run) ? rowOf(run) : undefined;
      if (key) about.set(key, [...about.get(key) ?? [], ...run.attempts]);
    }
    for (const [key, attempts] of about) { const took = spentLabel(attempts, events, usage); if (took) spent.set(key, took); }
  }
  // A rule reads at the end of the block of the request it came from. A request about one cut or edit that has left the
  // chat, or sits under its row inside another block, hands its rule to the block it belongs to.
  const learnedIn = (run: Run) => learned.filter(l => {
    const from = runOf.get(l.taskId)!;
    return from === run || (run === owner && (settled(from) || nested.has(from.root)));
  });

  // Whether Scarlet has this request and it can be stopped: such a request has Stop at its heading's right.
  const stoppable = (r: Run) => runIsActive(r.task) && !(waitingToStart(r.task) && r.root === r.task.id);

  const unit = (run: Run, inside = false): ReactElement => {
    const { task } = run;
    const ids = new Set(run.attempts.map(t => t.id));
    const mine = entries.filter(e => !!e.taskId && ids.has(e.taskId) && !(e.kind === "change" && folded.has(e.change.id)));
    const request = mine.find((e): e is Extract<ThreadEntry, { kind: "request" }> => e.kind === "request");
    // Scarlet's words for the editor: its reply, a question and the answer it got, a suggestion to play, why it stopped.
    const said: ReactNode[] = [];
    // Whether those words say what the request came to: a reply, or a suggestion to play.
    let told = false;
    // A suggestion of this request's is waiting to be played: its heading says so.
    let proposing = false;
    let recovery: { label: string; run(): void } | undefined;
    // While Scarlet is on a request about one cut or edit, the request shows its work and not what Scarlet wrote about
    // it: that reads on the cut or edit once it lands, and the request then leaves. Scarlet's redo of the request's
    // suggestion is the exception: nothing lands to say why the request is at work again, so its one line stays.
    const quiet = run !== owner && aboutOne(run) && runIsActive(task) && !isRedo(task);
    // Scarlet answers the editor's note and then closes the request, mostly in the same words. The closing message is
    // the reply; what it wrote on the note shows only while there is no other.
    const closed = entries.some(e => e.kind === "agent" && !e.onNote && ids.has((e.taskId ?? e.replyTo)!));
    // While every edit is listed, the list takes the place of Scarlet's reply; putting it away brings the reply back. The
    // short list of what needs the editor, shown without a click, leaves the reply where it is.
    // In the column of edits the list is never in the chat, so the reply stays where it is.
    const listing = !rail && run === owner && hasRows && passList[0] === "all";
    // Scarlet's recheck of a cut the editor approved, under that cut's row: its reason is its heading, not a line under its work.
    const autoHeading = inside && isRecheck(task);
    mine.forEach((e, i) => {
      if (autoHeading && e.kind === "system" && e.text === RECHECK_WORDS) return;
      // All of what Scarlet said: folded it keeps to three lines in the beta layout, and a click opens the rest.
      if (e.kind === "agent") { if (!quiet && !(e.onNote && closed)) { told = true; if (!listing) said.push(<Said key={i} className="req-say" text={e.fullText ?? e.text} />); } }
      // A question still waiting isn't in the chat: it sits on top of the message box, which answers it, and the band's
      // dot says it waits (the editor's choice, 2026-11-24). Once answered it stays, quiet, so the history still reads.
      else if (e.kind === "question") { if (e.answered) said.push(<p key={i} className="req-say is-quiet">{e.text}</p>); }
      // The editor's answer is their message: two lines at most, and a click opens the rest.
      else if (e.kind === "answer") said.push(<Said key={i} className="req-say is-yours" text={e.text} />);
      // An applied change is on the card's last row. A suggestion still says what it is and how to play it. A pass's
      // own proposals are its line, except a suggestion it left that isn't cuts to call: nothing else would show it.
      else if (e.kind === "change" && e.change.state !== "approved" && !isOpenPass(e.change, allTasks)
          && (!passTasks.has(e.taskId!) || (e.change.state === "ready" && !e.change.cutReasons?.length))) {
        told = true;
        if (waitsToPlay(e.change, thread) && !isDialoguePass(e.change)) proposing = true;
        // A pass's closing message is its reply, so its suggestion goes by what it changes.
        said.push(<ChangeReply key={i} thread={thread} entry={passTasks.has(e.taskId!) ? { ...e, text: e.change.description } : e} actions={actions} />);
      }
      // A finished pass whose closing check couldn't run: the pass stands, and the line says just that, with Retry after it.
      else if (e.kind === "system" && e.taskId === task.id && closingCheckFailed(task)) {
        const action = e.action;
        said.push(<p key={i} className="req-say is-note">{e.text}
          {action && <button type="button" className="simple-link req-recover" onClick={() => attempt(run.root, retryTask(action.taskId))}>Retry</button>}</p>);
      }
      else if (e.kind === "system" && e.taskId === task.id) {
        // The card's own row says it stopped or couldn't finish; only a specific reason adds to that.
        if (!UNSAID.test(e.text)) said.push(<p key={i} className={`req-say is-note${e.tone === "bad" ? " is-bad" : ""}`}>{e.text}</p>);
        const action = e.action;
        // Asked again since, and done: picking the old one up would do the same work a second time. The same words
        // about another cut or edit were other work, and leave this one to pick up.
        const redone = allTasks.some(t => t.state === "done" && Date.parse(t.createdAt ?? "") > Date.parse(task.createdAt ?? "") && requestText(t) === requestText(task)
          && requestTargetKey(t, threadChanges) === requestTargetKey(task, threadChanges));
        if (action && !redone) recovery = { label: action.label === "Resume agent" ? "Resume" : "Retry", run: () => attempt(run.root, retryTask(action.taskId)) };
      }
    });
    const final = finalOf(run);
    // The requests about one of this block's cuts or edits, each drawn under its row.
    // One that asks a question, or stopped early and offers its one action, itself waits on the editor.
    const below = !inside && run === owner ? [...nested].map(([root, key]) => ({ key, run: runs.find(r => r.root === root)! })) : [];
    const nests: Nest[] = below.map(({ key, run: about }) => {
      const runEvents = events[about.task.id] ?? [];
      const lastEv = runEvents.at(-1);
      const runFinal = finalOf(about);
      const runHeld = about.task.state === "queued" ? actions.waitsOn?.(about.task)?.words ?? "" : "";
      const version = [
        about.root, about.task.id, about.task.state, about.task.question ?? "", about.task.summary ?? "",
        about.attempts.map(t => `${t.id}:${t.state}`).join(","),
        runEvents.length, lastEv ? `${lastEv.id}:${lastEv.type}` : "",
        runFinal ? `${runFinal.id}:${runFinal.state}` : "",
        failed?.run === about.root ? failed.text : "",
        editingPaused ? "1" : "0", actions.nextQueuedId === about.task.id ? "1" : "0",
        actions.answering === about.task.id ? "1" : "0", runHeld,
        showTokens ? JSON.stringify(usage?.[about.task.id] ?? null) : "",
      ].join("|");
      return { key, node: unit(about, true), needs: about.task.state === "waiting_for_user" || !runIsActive(about.task), version };
    });
    const rows = run === owner && hasRows ? (aside: ReactNode) => summed
      ? <PassSummary projectId={projectId} thread={thread} threadOrder={threadOrder} edits={listed} rejected={rejected} actions={actions} aside={aside} list={passList} listedNeed={passListed} working={runIsActive(task)} nests={nests} spent={spent} linger={linger} lastOpen={lastOpen} listLoaded={listLoaded} askingRowKey={askingRowKey} />
      : <ThreadResult projectId={projectId} thread={thread} threadOrder={threadOrder} edits={listed} rejected={rejected} actions={actions} aside={aside} working={runIsActive(task)} nests={nests} spent={spent} list={passList} listedNeed={passListed} wasShowing={wasShowing} linger={linger} lastOpen={lastOpen} listLoaded={listLoaded} askingRowKey={askingRowKey} /> : undefined;
    // A request about one cut or edit says what it did there, and its row opens that cut or edit on the timeline.
    const target = targets.get(run.root);
    const pass = actions.pass?.threadId === thread.id ? actions.pass : undefined;
    const call = target && !target.edit && pass?.change.id === target.changeId
      ? pass!.calls.find(c => c.index === target.call && c.state !== "revising") : undefined;
    const aimed = target?.edit;
    // The same edit can be open from the list on the request that made it. Then this card isn't the one that's open.
    const showingIt = aimed ? actions.showingFrom === run.root && !!actions.showing && matchesEdit(actions.showing, aimed)
      : !!call && actions.listening?.changeId === pass!.change.id && actions.listening.index === call.index;
    const open = aimed ? () => actions.openEdit(thread, aimed, run.root) : call ? () => pass!.openCall(call.index)
      : final?.state === "approved" && run !== owner ? () => actions.play(thread, final) : undefined;
    // The block holds the place above the message box while Scarlet is on it, or on a request drawn inside it.
    const isPinned = !inside && (pinned === run.root || (!!pinned && nests.length > 0 && nested.has(pinned)));
    // The heading is the editor's words, with no name or number: "Edit 14" anywhere is an edit Scarlet made. A request
    // about one cut or edit says which before its words, in the tag the message box showed: "Cut 2" for a call, by its
    // time otherwise. A request about a whole edit says which the same way.
    const tag = request?.revisionLabel ? tagOf(tagFor(request) ?? request.revisionLabel) : undefined;
    const about = aboutOne(run) ? actions.cutName?.(aimOf(run).context) ?? tag : undefined;
    // Where the request stands, at the right of its heading: a dot while Scarlet asks, a word once it stopped early or
    // left a suggestion, and Paused while editing waits for Resume. The review count appears on For you.
    const ended = runEnded(task);
    const editsProject = isProjectEditTask(task);
    const paused = editingPaused && editsProject && task.state === "queued";
    const stands = runIsActive(task) ? task.state === "waiting_for_user" ? <span className="unit-dot" aria-hidden />
        : paused ? <span className="unit-word" title={PAUSED_HINT}>Paused</span> : null
      : ended ? <span className="unit-word">{ended}</span> : proposing ? <span className="unit-word">Suggestion</span> : null;
    // Scarlet works on several cuts or edits at once, an agent on each. The block that holds one of them says how many
    // there are, in the heading's place for where a request stands: each has its own row, and some may be out of view.
    const atOnce = actions.atOnce ?? 0;
    const among = !inside && atOnce > 1 && [run, ...(run === owner ? runs.filter(r => nested.has(r.root)) : [])]
      .some(r => aboutOne(r) && isWorking(r.task.state));
    // A question waiting isn't in the chat: it sits on top of the message box while the box answers it. With the box
    // aimed elsewhere, Answer after the dot puts it back on the question (and opens the cut a question is about).
    const answerHere = task.state === "waiting_for_user" && !!task.question && thread.question?.id === task.id && actions.answering !== task.id
      ? <button type="button" className="simple-link is-warn unit-answer" onClick={() => actions.reply(thread)}>Answer</button> : null;
    const standing = stands ?? (among ? <span className="unit-word is-at-once" title={`Scarlet is working on ${atOnce} cuts or edits at the same time.`}>Working on {atOnce} at once</span> : null);
    const stop = stoppable(run) ? () => attempt(run.root, cancelTask(task.id)) : undefined;
    // Scarlet has a request under one of this block's rows: the band reads as the one it works on, on two lines.
    const worksUnder = !inside && !!request && run === owner && runs.some(r => nested.has(r.root) && isProjectEditTask(r.task) && stoppable(r));
    // Stop stays on the message since it only stops this request.
    const stops = editsProject && !!stop;
    const editActions = stops ?
      <div className="unit-actions">
        <TipButton className="unit-stop-edit" tip="Stop this edit" aria-label={request ? `Stop this edit: ${request.text}` : "Stop this edit"}
          aria-description="What it already changed stays, and the next request can start." onClick={stop}><Icon name="stop" size={13} /></TipButton></div>
      : undefined;
    const requestControl = editActions ?? (!editsProject && stop && <button type="button" className="simple-link unit-stop" onClick={stop}>Stop</button>);
    // The request Scarlet is working on keeps its time and tokens in view, where they count up. Any other (finished,
    // stopped, waiting on the editor or its turn) and one under a row show them when the pointer rests on the bubble:
    // under a row, the row and the line of what Scarlet is on say enough.
    const quietMetrics = inside || !isWorking(task.state);
    const metrics = <RequestMetrics attempts={run.attempts} events={events} quiet={quietMetrics} />;
    const headingEnd = <>{metrics}{requestControl}</>;
    // The sentence Scarlet opened the request with is written once and stays: picked up after a pause or a restart,
    // the request keeps it, from the first attempt that said one. Only an attempt's whole history says whether it did.
    const before = task.resumeRootId && isWorking(task.state) ? run.attempts.filter(t => t !== task && (t.resumeRootId ?? t.id) === task.resumeRootId) : [];
    const opened = before.every(t => wholeHistory.includes(t.id)) ? before.find(t => runAim(events[t.id] ?? [])) : undefined;
    // A recheck Scarlet began itself is headed too, by its reason after the Auto tag: where it stands and its controls
    // are at that heading's right, as a request's are, and not said again on a row under it.
    const headed = !!request || autoHeading;
    const bundle = <RunBundle task={task} events={events[task.id] ?? []} opening={opened && events[opened.id]} changes={thread.changes} finalChange={final} banded={headed} under={inside} callTime={actions.callTime}
        say={said.length ? <div className="req-said">{said}</div> : undefined} told={told} result={rows} recovery={recovery}
        // Under its call's row, that row is the cut it saved, with Scarlet's note: the note isn't said again under it.
        // A pass's calls are listed for as long as it waits, so a request keyed to one is always under its row.
        summary={target?.note} listedAbove={inside && !!nested.get(run.root)?.startsWith("call/")} showing={showingIt} onOpen={proposing ? undefined : open}
        // Scarlet's other requests have no heading. Their menu stays with the active run's row.
        actions={headed ? undefined : editActions} onStop={headed || editsProject ? undefined : stop} paused={paused}
        held={task.state === "queued" ? actions.waitsOn?.(task) : undefined}
        // Only the thread's last run can be finished, and not while another request in it is under way. One about a
        // single cut or edit isn't held to being the last, as with Resume: a pass's thread takes a request for every
        // call, and another call's request would take its way to finish from it for good.
        {...(!thread.active && !thread.question && (task === thread.tasks.at(-1) || (aboutOne(run) && !overtaken(run))) && {
          onResume: () => attempt(run.root, retryTask(task.id)),
          onWaitForTranscripts: (on: boolean) => attempt(run.root, continueWhenReady(task.id, on)),
        })} />;
    const wrong = failed?.run === run.root && <p className="simple-error unit-error" role="alert">{failed.text}</p>;
    // Inside another request's block, under the row it is about: its tag and the editor's words, with where it stands
    // at their right, as in a block's heading, and its work. Under its row the row names it, and the tag is hidden.
    // A recheck Scarlet started itself has no words of the editor's: its reason takes their place, after an Auto tag
    // that stays in view, so it never reads as a revision nobody asked for (2026-11-22).
    if (inside) return <div key={run.root} className="subunit" data-run={run.root}>
      {request && <div className="subunit-msg"><span className="simple-who">You</span>
        <Said lead={<span className="simple-revising">{about ?? "Revision"}</span>} text={request.text} /><span className="unit-state">{standing}</span>{answerHere}{headingEnd}</div>}
      {!request && autoHeading && <div className="subunit-msg"><span className="simple-who">Scarlet</span>
        <Said lead={<span className="simple-revising is-auto" title="Scarlet started this itself">Auto</span>} text={RECHECK_WORDS} /><span className="unit-state">{standing}</span>{answerHere}{headingEnd}</div>}
      {bundle}
      {wrong}
    </div>;
    // A press on a request's band picks it: its band is deep violet and its edits are the ones on the timeline, whether
    // it has finished or Scarlet is still on it, and whether or not it has applied anything yet. Pressed again it lets
    // go, and the timeline marks every request's edits. Either press shows the whole timeline. The band's words stay
    // folded, so a press on them is the band's too. Its arrow, links and Stop keep their own presses.
    const markable = !!actions.mark;
    const marked = markable && actions.marked === thread.id;
    const pressable = markable || !!actions.fitTimeline;
    const block = <div key={run.root} className="unit" data-run={run.root} data-pinned={isPinned || undefined}>
      {request && <div className={`unit-msg${pressable ? " is-markable" : ""}${marked ? " is-marked" : ""}${isWorking(task.state) || worksUnder ? " is-live" : ""}`}
        aria-current={marked || undefined} onClick={pressable ? e => {
          if ((e.target as Element).closest('button, a, input, textarea, [role="menu"]') || window.getSelection()?.toString()) return;
          if (markable) actions.mark!(thread.id);
          actions.fitTimeline?.();
        } : undefined}>
        <span className="simple-who">You</span>
        {/* The editor's words are a bubble at the chat's right, so what they said never reads as Scarlet's. Quiet
            metrics sit on the bubble itself (never inside display:none .unit-meta) so hover stats anchor to the bubble. */}
        <div className="unit-bubble">
          <Said fixed lead={<>{(about ?? tag) && <span className="simple-revising">{about ?? tag}</span>}<MarkedFrameOnRequest projectId={projectId} task={task} /></>} text={request.text} />
          {quietMetrics && metrics}
        </div>
        <div className="unit-meta">
          <span className="unit-state">{standing}</span>
          {answerHere}
          {!quietMetrics && metrics}
          {requestControl}</div></div>}
      {bundle}
      {learnedIn(run).map(l => <LearnedLine key={l.id} learning={l} onReview={actions.reviewLearning} />)}
      {wrong}
    </div>;
    // Scarlet's closing words on what it applied read under the block and go where it goes: above the message box
    // with it, and out of the chat with a request about one cut or edit that has left. The open list takes their place.
    const replies = listing ? [] : entries.flatMap((e, i) => closingReply(e) && ids.has(e.replyTo!) ? [loose(e, i)] : []);
    // Always the same shape, so the block isn't mounted anew when its replies give way to its list and come back.
    const node = <Fragment key={run.root}>{block}{replies}</Fragment>;
    return isPinned && pinHost ? createPortal(node, pinHost, run.root) : node;
  };
  const placed = new Set<string>();
  const nodes = entries.flatMap((item, i) => {
    if (item.kind === "change" && folded.has(item.change.id)) return [];
    const run = item.taskId ? runOf.get(item.taskId) : undefined;
    if (run) {
      if (placed.has(run.root)) return [];
      placed.add(run.root);
      if (settled(run) || nested.has(run.root)) return [];
      return [unit(run)];
    }
    // A closing reply is drawn with the request it answers.
    if (closingReply(item) && runOf.has(item.replyTo!)) return [];
    // An applied edit no request made is said once, by the sentence that lists it below, with its link (2026-11-14:
    // "Put the camera in the bottom-right corner" read twice).
    if (!owner && (hasRows || !listLoaded) && item.kind === "change" && item.change.state === "approved") return [];
    // What a queued request says is in the tray.
    return item.taskId ? [] : [loose(item, i)];
  });
  // A run that has said nothing yet still shows.
  for (const run of runs) if (!placed.has(run.root) && !settled(run) && !nested.has(run.root)) nodes.push(unit(run));
  // Edits with no request behind them, such as an older change, still list in a card of their own.
  if (!owner && hasRows) nodes.push(<div key="edits" className="req">{summed
    ? <PassSummary projectId={projectId} thread={thread} threadOrder={threadOrder} edits={listed} rejected={rejected} actions={actions} list={passList} listedNeed={passListed} linger={linger} lastOpen={lastOpen} listLoaded={listLoaded} askingRowKey={askingRowKey} />
    : <ThreadResult projectId={projectId} thread={thread} threadOrder={threadOrder} edits={listed} rejected={rejected} actions={actions} list={passList} listedNeed={passListed} linger={linger} lastOpen={lastOpen} listLoaded={listLoaded} askingRowKey={askingRowKey} />}</div>);
  return <section ref={section} className="simple-turn" data-log-label="Edit thread" aria-label={thread.title} data-thread={thread.id}>
    {nodes}
  </section>;
}
