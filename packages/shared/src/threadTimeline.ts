import { appliedReviewChange, clipRange, cutKindRow, historyLineage, intervalCandidates, makeTimeMap, removedJoins, reviewCutSummaries, reviewKindRows, reviewReasons, timelineDuration, withHandles, type Change, type CutAssessment, type MediaAsset, type Timeline, type TimeRange } from "@scarlet/timeline";
import type { Thread } from "./threads.js";
import { classifyEdits, type EditKind } from "./editKind.js";

export interface EditRef { changeId: string; spot: number }
export interface ThreadEdit extends EditRef {
  label: string;
  range: TimeRange;
  /** Timeline position of a removal, inside its playable context. */
  at?: number;
  /** The original footage for this join, in the clock of the version that contains it. */
  beforeCut?: { version: string; removed: TimeRange };
  /** Earlier links to an edit continue to select its latest revision. */
  previous: EditRef[];
  /** What the editor should look or listen for before keeping this edit. */
  check?: string;
  /** Where to preview a localized review check in the version currently playing. */
  reviewRange?: TimeRange;
  /**
   * `check` without the times it names, once `reviewRange` places them on the working cut. They are in the clock of
   * the version Scarlet flagged, which later saves move: the card shows where the passage is now instead.
   */
  reviewSays?: string;
  /** A later change that supplied the review note for this same edit on the working cut. */
  reviewChangeId?: string;
  /**
   * The later edit whose reason to look this one now carries. It asks something new of an edit the editor may already
   * have kept or called, so keeping it is recorded under this identity and not the edit's own.
   */
  reviewRef?: EditRef;
  /** What changed, shown in the chat. */
  summary?: string;
  /** Why Scarlet chose the edit, shown on its card. */
  reason?: string;
  /** What the edit did, so the timeline draws a cut, a sound fix or a zoom each for what it is. */
  kind?: EditKind;
  /**
   * When a later run raised `check` about this edit, already in the video. Keeping the edit before then doesn't
   * settle that doubt.
   */
  recheck?: string;
  /** Another request made this edit. It is listed here because this request found a doubt about it. */
  elsewhere?: true;
  /**
   * The edit only left a marker for the editor, such as a spot for footage the project doesn't have. Nothing in the
   * video changed, so what it asks of them is its note.
   */
  marker?: true;
  /**
   * What a marker edit asks of the editor: Scarlet's reason to look when it gave one, or else what its to-do marker
   * says. It outlives a revision, whose `check` then only says it was revised.
   */
  todo?: string;
  /**
   * The editor rejected this edit and what it changed was put back. It isn't in the video any more: its row stays in
   * its request's list, marked Rejected, at the place it was.
   */
  rejected?: true;
}

/** The editor's words for a rejection Scarlet was asked to make, in the chat and in the queue. */
export const REJECT_MESSAGE = "Reject edit";

/** A request the × on an edit's card sent: the editor wrote nothing, and what Scarlet is told is its instruction. */
export const isRejectRequest = (task: { instruction?: string; context: { message?: string } }) =>
  task.context.message === REJECT_MESSAGE && task.instruction !== REJECT_MESSAGE;

/** Why a revision of a flagged edit asks for a look when Scarlet gave it no reason of its own. */
export const REVISED_CHECK = "Revised";

export function threadRevision(thread: Thread) {
  return JSON.stringify([thread.tasks.at(-1)?.id, thread.changes.at(-1)?.id, thread.updatedAt]);
}

export function isThreadDone(thread: Thread, completed?: Record<string, string>) {
  return thread.status !== "working" && !thread.active && !thread.question && completed?.[thread.id] === threadRevision(thread);
}

export function matchesEdit(edit: ThreadEdit, ref: EditRef) {
  return (edit.changeId === ref.changeId && edit.spot === ref.spot) ||
    edit.previous.some(item => item.changeId === ref.changeId && item.spot === ref.spot);
}

interface SavedEdit extends ThreadEdit {
  version: string;
  /** The later review check's location in the version where Scarlet found it. */
  reviewLocation?: { version: string; range: TimeRange };
  /** Scarlet named this edit itself, in the list it saved with its change, as against a cut read from what was removed. */
  named?: boolean;
  /** Named at a point where its own save neither took footage out nor put any back. */
  still?: boolean;
  /** Named at a point by a save of the whole video, which can move the join of a cut that an earlier save made. */
  resaved?: boolean;
  /** The footage this edit's save put back where the edit was named, in the clock of the version it saved. */
  putBack?: TimeRange;
  /** What a moved marker still says, when its `todo` comes from that and not from words this change wrote. */
  markerSays?: string;
}

/** A cut Scarlet named no edit for, in a video it built from the pieces to keep. */
const LEFT_OUT = "Cut";

/** How far apart, in seconds on the working cut, two named edits can sit and still be the same place. */
const SAME_PLACE = 1;

const TIMING_KEYS = new Set(["sourceIn", "sourceOut", "timelineIn", "timelineOut", "speed"]);
const rangeKey = ({ start, end }: TimeRange) => `${start}/${end}`;

/** A step that leaves every clip where and when it was, such as the fade that smooths a cut's join. */
function keepsTiming(op: Record<string, unknown>) {
  if (op.op === "updateTrack" || op.op === "addMarker" || op.op === "removeMarker" || op.op === "updateMarker") return true;
  const patch = op.op === "updateClip" && op.patch && typeof op.patch === "object" ? Object.keys(op.patch) : undefined;
  return !!patch && !patch.some(key => TIMING_KEYS.has(key));
}

/**
 * Older dialogue batches store descending removals in the input timeline clock. `smoothed` also reads a cut that
 * carries steps which move nothing in time, so its removals are still in the clock of the version it cut.
 *
 * A pass applied onto an edit that had moved keeps the numbers of the calls the editor skipped (`restoredCuts`) and
 * no list of its joins. Those cuts stayed in the video, so they are left out. Each cut that went in keeps its place on
 * the version the pass proposed, where the skipped footage is out as well.
 */
function dialogueEdits(change: Change, smoothed = false) {
  if (!change.ops?.length) return;
  const reasons = change.cutReasons && [...change.cutReasons].sort((a, b) => a.start - b.start);
  const skipped = !change.appliedReview && change.restoredCuts?.length ? new Set(change.restoredCuts) : undefined;
  let removed = 0;
  let lastEnd = 0;
  let place = 0;
  let call = -1;
  const result: { label: string; range: TimeRange; removed: TimeRange; replaces?: EditRef; check?: string; summary?: string; reason?: string }[] = [];
  for (let i = change.ops.length - 1; i >= 0; i--) {
    const op = change.ops[i]!;
    if (smoothed && keepsTiming(op)) continue;
    if (op.op !== "rippleDelete" || op.trackIds !== undefined || typeof op.start !== "number" ||
        typeof op.end !== "number" || op.start < lastEnd || op.end <= op.start) return;
    const at = op.start - removed;
    const reason = reasons?.[place++];
    // The review numbers its calls as planCutReview lists them: a cut that starts where the last ended is the same call.
    if (call < 0 || op.start > lastEnd) call++;
    const own = reason?.start === op.start && reason.end === op.end ? reason : undefined;
    if (!skipped?.has(call)) result.push({ label: own?.summary ?? cutKindRow(own?.kind) ?? own?.reason ?? change.description,
      range: { start: at, end: at }, removed: { start: op.start, end: op.end }, replaces: undefined,
      check: own?.check, summary: own?.summary, reason: own?.reason });
    removed += op.end - op.start;
    lastEnd = op.end;
  }
  return result.length ? result : undefined;
}

type Cut = NonNullable<ReturnType<typeof dialogueEdits>>[number];
/** A named time is read to a tenth of a second. */
const NAMED_SLACK = 0.05;

/**
 * The join each ranged cut was named around. A cut has no playback of its own, so it is often named by the second or
 * so either side of its join: footage that stayed, which the timeline would draw as kept. Each such edit takes the
 * join nearest its middle. One whose range still holds a join no edit took made several cuts, and stays a range.
 */
function rangedJoins(ranges: TimeRange[], kinds: EditKind[], cuts: Cut[]) {
  const joins = new Map<number, Cut>();
  if (!ranges.some((r, spot) => r.end > r.start && kinds[spot] === "cut")) return joins;
  // A join an edit named as a point takes is that edit's, found within the same hundredth as namedJoins finds it, so
  // the footage it removed is counted once.
  const claimed = new Set(namedJoins(ranges, cuts).values());
  const free = cuts.filter(cut => !claimed.has(cut));
  const candidates = intervalCandidates(free, cut => cut.range.start, cut => cut.range.start);
  const pairs = ranges.flatMap((range, spot) => range.end > range.start && kinds[spot] === "cut"
    ? candidates(range.start - NAMED_SLACK, range.end + NAMED_SLACK).map(cut => ({ spot, cut, off: Math.abs((range.start + range.end) / 2 - cut.range.start) })) : [])
    .sort((a, b) => a.off - b.off);
  const taken = new Set<Cut>();
  for (const { spot, cut } of pairs) {
    if (joins.has(spot) || taken.has(cut)) continue;
    joins.set(spot, cut);
    taken.add(cut);
  }
  for (const { spot, cut } of pairs) if (!taken.has(cut)) joins.delete(spot);
  return joins;
}

/**
 * The join each edit named as a point is on, among joins read from two versions. The point was named on the finished
 * video and the join found by its frames, so the two can sit a frame apart. Each point takes the join nearest it.
 */
function namedJoins(ranges: TimeRange[], cuts: Cut[]) {
  const candidates = intervalCandidates(cuts, cut => cut.range.start, cut => cut.range.start);
  const pairs = ranges.flatMap((range, spot) => range.start === range.end
    ? candidates(range.start - NAMED_SLACK, range.start + NAMED_SLACK).map(cut => ({ spot, cut, off: Math.abs(range.start - cut.range.start) })) : [])
    .sort((a, b) => a.off - b.off);
  const joins = new Map<number, Cut>();
  const taken = new Set<Cut>();
  for (const { spot, cut } of pairs) {
    if (joins.has(spot) || taken.has(cut)) continue;
    joins.set(spot, cut);
    taken.add(cut);
  }
  return joins;
}

function namedEdits(change: Change, readCuts: () => ReturnType<typeof dialogueEdits>): Change["timelineEdits"] {
  if (change.approvedSpots || change.appliedReview) return;
  // The names an agent gave its edits don't say which cut each is for. Once the editor skipped some, the edits are read from what was applied.
  if (change.timelineEdits?.length && !change.restoredCuts?.length) return change.timelineEdits;
  // Preserve the stored spot identities of older, unnamed proposals. Every cut has its reason, also the ones `cuts` leaves out as skipped.
  const cuts = readCuts();
  if (cuts && change.ops?.length === change.cutReasons?.length) return cuts.map(({ label, range, check, summary, reason }) => ({ label, range, check, summary, reason }));
}

/** Approval validates the selected diff spots in timeline order. Keep their applied ranges and spot indices. */
function approvedNotes(change: Change, applied: Change) {
  if (applied === change || !change.timelineEdits?.length) return;
  if (change.appliedReview) {
    const named = intervalCandidates(change.timelineEdits.filter(e => e.range.start === e.range.end), e => e.range.start, e => e.range.end);
    const joins = intervalCandidates(change.appliedReview.joins.flatMap(j => j.proposedAt === undefined ? [] : [j.proposedAt]), at => at, at => at);
    return change.appliedReview.joins.map(({ proposedAt }) => {
      if (proposedAt === undefined) return;
      const notes = named(proposedAt - NAMED_SLACK, proposedAt + NAMED_SLACK);
      const note = notes.length === 1 ? notes[0] : undefined;
      if (!note || joins(note.range.start - NAMED_SLACK, note.range.start + NAMED_SLACK).length !== 1) return;
      const { label, check, summary, reason } = note;
      if (summary || reason) return { label, check, summary, reason };
    });
  }
  if (!change.approvedSpots) return;
  const approved = new Set(change.approvedSpots);
  const spots = change.ranges.filter((_, index) => approved.has(index));
  if (spots.length !== applied.ranges.length) return;
  const named = intervalCandidates(change.timelineEdits, e => e.range.start, e => e.range.end);
  const proposal = intervalCandidates(change.ranges, r => r.start, r => r.end);
  // A named edit can provide context around a join. A one-to-one match keeps a note with the edit it describes.
  return spots.map(spot => {
    const notes = named(spot.start, spot.end);
    const note = notes.length === 1 ? notes[0] : undefined;
    if (!note || proposal(note.range.start, note.range.end).length !== 1) return;
    const { range, label, check, summary, reason } = note;
    const contained = (range.start <= spot.start && spot.end <= range.end) || (spot.start <= range.start && range.end <= spot.end);
    if (contained && (summary || reason)) return { label, check, summary, reason };
  });
}

/** Find each applied join's matching assessment by its original index or exact range. */
function appliedCutNotes(change: Change) {
  if (!change.appliedReview || !change.cutAssessments?.length) return;
  const byIndex = new Map<number, CutAssessment | undefined>();
  const byRange = new Map<string, CutAssessment | undefined>();
  for (const assessment of change.cutAssessments) {
    const note = !assessment.provisional && assessment.verdict !== "keep" && !assessment.proposes ? assessment : undefined;
    const key = rangeKey(assessment);
    byIndex.set(assessment.index, byIndex.has(assessment.index) ? undefined : note);
    byRange.set(key, byRange.has(key) ? undefined : note);
  }
  return change.appliedReview.joins.map(join => join.reviewIndex === undefined
    ? byRange.get(rangeKey(join.removed)) : byIndex.get(join.reviewIndex));
}

export function namedTimelineEdits(change: Change): Change["timelineEdits"] {
  return namedEdits(change, () => dialogueEdits(change));
}

/**
 * Everything a cut change took out, in the clock of the version it cut (`beforeCut.version` of its edits), and the
 * version holding the result. Undefined when the change did more than remove footage and smooth its joins, unless it
 * built the video and the engine read what it left out.
 */
export function changeRemovals(change: Change): { removed: TimeRange[]; version: string } | undefined {
  if (change.appliedReview) {
    return { removed: change.appliedReview.joins.map(j => j.removed), version: change.appliedVersion ?? change.toVersion };
  }
  const cuts = !change.approvedSpots ? dialogueEdits(change, true) : undefined;
  if (cuts?.length) return { removed: cuts.map(c => c.removed), version: change.toVersion };
  // A change that built the video cut nothing from the version before it. What it left out is in the clock of the
  // version that plays it all, which is the one its edits name as theirs.
  if (!cuts && !change.approvedSpots && change.leftOut?.version && change.leftOut.joins.length) {
    return { removed: change.leftOut.joins.map(j => j.removed), version: change.toVersion };
  }
}

/** The project's files, so an edit that laid a graphic over the picture is told from b-roll. */
type ProjectFiles = readonly Pick<MediaAsset, "id" | "kind" | "source">[];

/** Project the conversation's changes into distinct edit identities before translating their times. */
function savedEdits(thread: Thread, visible: (version: string) => boolean, read?: (version: string) => Timeline | undefined, fps = 30, media?: ProjectFiles) {
  const edits: SavedEdit[] = [];
  // The latest doubt this request's runs raised about an edit already in the video (`Change.flags`).
  const runs = new Set(thread.tasks?.map(t => t.id));
  // A change that put a rejected edit back: the engine's own says so, and one Scarlet made was asked for by the ×.
  const rejections = new Set(thread.tasks?.filter(isRejectRequest).map(t => t.id));
  const rejects = (change: Change) => !!change.rejects || (!!change.taskId && rejections.has(change.taskId));
  const flagOn = (change: Change, spot: number) => change.flags?.findLast(f => f.spot === spot && runs.has(f.taskId));
  const raise = (edit: SavedEdit, flag: NonNullable<Change["flags"]>[number] | undefined) => {
    if (!flag) return;
    edit.check = flag.check;
    edit.recheck = flag.at;
    edit.reviewLocation = flag.location;
  };
  // An edit another request made comes first, as it was in the video before this request's own: a revision this
  // request then makes of it takes its place. So does one its own request or any other made since (`replaces`): the
  // list shows the edit as it is now, never a version that has left the video.
  for (const change of thread.flagged ?? []) {
    for (const edit of savedEdits({ changes: [change] } as Pick<Thread, "changes"> as Thread, visible, read, fps, media)) {
      const replaces = change.timelineEdits?.[edit.spot]?.replaces;
      const prior = replaces ? edits.findIndex(e => matchesEdit(e, replaces)) : -1;
      const flag = flagOn(change, edit.spot);
      if (prior < 0 && !flag) continue;
      raise(edit, flag);
      edit.elsewhere = true;
      if (prior < 0) {
        edits.push(edit);
        continue;
      }
      const replaced = edits[prior]!;
      edit.previous = [...replaced.previous, { changeId: replaced.changeId, spot: replaced.spot }];
      // As with a revision made here: the editor was asked to check the edit, so its new version is theirs to check.
      if (replaced.check && !edit.check) edit.check = REVISED_CHECK;
      if (edit.marker && replaced.todo && (!edit.todo || edit.todo === edit.markerSays)) edit.todo = replaced.todo;
      edits[prior] = edit;
    }
  }
  for (const change of thread.changes) {
    const appliedVersion = change.appliedVersion ?? change.toVersion;
    if (change.state !== "approved" || !visible(appliedVersion)) continue;
    const applied = appliedReviewChange(change);
    const dialogue = !change.approvedSpots && !change.appliedReview ? dialogueEdits(change) : undefined;
    const named = namedEdits(change, () => dialogue);
    // A save of the whole video has no steps to read. What it took out and put back is read from the versions either side.
    const saved = named && !change.ops?.length && read ? { before: read(change.fromVersion), after: read(change.toVersion) } : undefined;
    const found = saved?.before && saved.after ? { before: saved.before, after: saved.after } : undefined;
    // A change that built the video from the pieces to keep never had the rest on its timeline. The engine read what
    // it left out between them once it was applied, with a version that plays it.
    // A change that took its footage out as cuts, with or without the fades that smooth them, is read from those.
    const rippled = dialogue ?? (!change.approvedSpots && !change.appliedReview ? dialogueEdits(change, true) : undefined);
    const built = named && !rippled && change.leftOut?.version && change.leftOut.joins.length
      ? { version: change.leftOut.version, joins: change.leftOut.joins } : undefined;
    // What the change says it did is about the footage it placed ("Kept the complete opening"), so a stretch it left
    // out and named nothing for goes by what it is.
    const taken = (found ? removedJoins(found.before, found.after, fps) : built?.joins)?.map((join): Cut => ({ label: built ? LEFT_OUT : change.description,
      range: { start: join.at, end: join.at }, removed: join.removed, replaces: undefined }));
    const returned = taken && found ? removedJoins(found.after, found.before, fps).map(join => join.removed) : undefined;
    const cuts = rippled ?? taken;
    const removals = new Map(cuts?.map(cut => [cut.range.start, cut]));
    const reasons = change.appliedReview && reviewReasons(change, change.appliedReview.joins);
    const summaries = change.appliedReview && reviewCutSummaries(change, change.appliedReview.joins);
    const kindRows = change.appliedReview && reviewKindRows(change, change.appliedReview.joins);
    const cutNotes = appliedCutNotes(change);
    const approved = approvedNotes(change, applied);
    const entries = named ?? applied.ranges.map((range, index) => {
      const plannedReasons = reasons?.[index];
      const planned = plannedReasons?.join(" · ");
      const reason = planned && (change.cutReasons || planned !== change.description) ? planned : undefined;
      const assessment = cutNotes?.[index]?.reason;
      const note = approved?.[index];
      const summary = cutNotes?.[index]?.summary ?? summaries?.[index] ?? note?.summary;
      const combined = reason && assessment && !plannedReasons?.includes(assessment)
        ? `${reason}${/[.!?]$/.test(reason) ? " " : ". "}${assessment}` : reason ?? assessment;
      return { range, label: note?.label ?? summary ?? kindRows?.[index] ?? (planned || change.description), summary, reason: combined ?? note?.reason,
        check: note?.check, replaces: undefined };
    });
    const ranges = entries.map(e => e.range);
    // A pure pass already computed the joins on its finished clock. Skipped calls are absent from that list.
    const rippleJoins = dialogue && !change.restoredCuts?.length ? dialogue : undefined;
    const clocks = !rippleJoins && read ? { before: read(change.appliedOnto ?? change.fromVersion), after: read(appliedVersion), media } : { media };
    const classified = classifyEdits(change, ranges, clocks, rippleJoins ?? (taken && returned && [...taken,
      ...returned.map(range => ({ range, facet: "restore" as const }))]));
    const fromSteps = classified.kinds;
    // What a built change's steps say is that footage was placed. An edit named on a join where footage was left out is a cut.
    const kinds = built && taken ? fromSteps.map((kind, spot) => taken.some(cut => cut.range.start >= ranges[spot]!.start - NAMED_SLACK &&
      cut.range.start <= ranges[spot]!.end + NAMED_SLACK) ? "cut" : kind) : fromSteps;
    const joins = named && cuts ? rangedJoins(ranges, kinds, cuts) : undefined;
    // A spot read as a cut took footage out there, whatever markers it also left.
    const marked = named ? classified.markers.map((marker, spot) => marker && kinds[spot] === "other") : [];
    // A cut named at a point is the join nearest it: an agent names times to the hundredth, and the join its removals
    // made can fall between ("271.28" for 271.2833), which read the cut as some other edit.
    const atJoin = taken?.length ? namedJoins(ranges, taken) : named && rippled?.length ? namedJoins(ranges, rippled) : undefined;
    const beforeVersion = change.appliedReview?.originalVersion ?? built?.version ?? change.fromVersion;
    const shown = new Map<Cut, SavedEdit>();
    for (const [spot, item] of entries.entries()) {
      const joined = joins?.get(spot) ?? atJoin?.get(spot);
      const range = joined?.range ?? item.range;
      const edit: SavedEdit = { changeId: change.id, spot, label: item.label, range,
        version: named ? change.toVersion : appliedVersion, previous: [], ...(named && change.timelineEdits?.length && { named: true }) };
      const check = "check" in item ? item.check : undefined;
      if (check) edit.check = check;
      const sameSpot = cuts?.[spot];
      const cut = joined ?? (sameSpot?.range.start === range.start ? sameSpot : removals.get(range.start));
      const summary = item.summary ?? cut?.summary;
      if (summary) edit.summary = summary;
      const reason = item.reason ?? cut?.reason ?? change.reason;
      if (reason) edit.reason = reason;
      raise(edit, flagOn(change, spot));
      // Two things Scarlet named on the one join are one cut: its row says both, and the footage is counted once.
      const shared = built && !joined && kinds[spot] === "cut" && taken ? taken.find(cut => shown.has(cut) &&
        cut.range.start >= item.range.start - NAMED_SLACK && cut.range.start <= item.range.end + NAMED_SLACK) : undefined;
      const first = shared && shown.get(shared);
      if (first && !item.replaces) {
        if (summary && summary !== first.summary) first.summary = first.summary ? `${first.summary} ${summary}` : summary;
        if (reason && reason !== first.reason) first.reason = first.reason ? `${first.reason} ${reason}` : reason;
        if (check && !first.check) first.check = check;
        continue;
      }
      if (built && joined) shown.set(joined, edit);
      // A save of the whole video: the join an edit is named on, as a point or a stretch, is that edit's.
      else if (found && cut && (joined || edit.beforeCut || range.start === range.end)) shown.set(cut, edit);
      const removed = change.appliedReview?.joins[spot]?.removed ?? cut?.removed;
      if (removed && range.start === range.end) edit.beforeCut = { version: beforeVersion, removed };
      const kind = edit.beforeCut ? "cut" : kinds[spot];
      if (kind) edit.kind = kind;
      if (marked[spot] && !edit.beforeCut) {
        edit.marker = true;
        const todo = edit.check ?? classified.asks[spot];
        if (todo) edit.todo = todo;
        if (!edit.check && todo && !classified.restated[spot]) edit.markerSays = todo;
      }
      if (found && edit.named && kind === "other" && range.start === range.end) edit.still = true;
      // Only a save that took footage out at the point can have moved a cut's join there. A punch-in or a title named on a
      // join changed no footage, and is an edit of its own. A save made of steps that left footage out at the join (`built`)
      // moved it too: on Matt's pass a later save rolled the edges of six cuts it had made, “Extend end of ‘subscription.’”,
      // and each cut showed twice, the first still flagged and playing its old clipped join (2026-11-20).
      if ((found || built) && edit.named && range.start === range.end && edit.beforeCut) edit.resaved = true;
      const back = edit.named && kind === "restore" ? returned?.filter(r => r.start <= range.end + NAMED_SLACK && r.end >= range.start - NAMED_SLACK) : undefined;
      if (back?.length) edit.putBack = { start: Math.min(...back.map(r => r.start)), end: Math.max(...back.map(r => r.end)) };
      const prior = item.replaces ? edits.findIndex(e => matchesEdit(e, item.replaces!)) : -1;
      if (prior >= 0) {
        const replaced = edits[prior]!;
        edit.previous = [...replaced.previous, { changeId: replaced.changeId, spot: replaced.spot }];
        // A rejected edit keeps its own words on its row, which then says it was rejected: nothing is left to check.
        if (rejects(change)) {
          edit.rejected = true;
          // The engine's own put-back is named as the row was when the editor rejected it, which for a cut is the words
          // beside it (`cutRowWords`): the saved label would turn its row back into "Shortened a pause". What Scarlet
          // put back, it named itself ("Restored…"), so that one reads as the edit it took out.
          if (!change.rejects) edit.label = replaced.label;
          if (replaced.summary) edit.summary = replaced.summary; else delete edit.summary;
          if (replaced.reason) edit.reason = replaced.reason; else delete edit.reason;
          delete edit.check;
        }
        // The editor sent back an edit that was theirs to check, so its new version is theirs to check too, whether
        // or not Scarlet flagged it again. The old reason was about the old version.
        else if (replaced.check && !edit.check) edit.check = REVISED_CHECK;
        // A revised marker that doesn't say again what to do still asks what it asked.
        if (edit.marker && replaced.todo && (!edit.todo || edit.todo === edit.markerSays)) edit.todo = replaced.todo;
        edits[prior] = edit;
      } else edits.push(edit);
      // A marker left for the editor asks them to do something, so it waits on them until they say it's done.
      if (edit.marker && !edit.check && edit.todo) edit.check = edit.todo;
    }
    // The stretches it left out that Scarlet named no edit for are cuts all the same, listed after the ones it named.
    // So are the ones a save of the whole video took out: a first pass that rewrote the timeline to tighten the dialogue
    // named ten edits for some two hundred joins, and the rest could not be opened, revised or undone (2026-11-16).
    // One of those where an earlier cut already joins moved that cut's join, and is that cut (`resaved`).
    if ((built || found) && taken) {
      let spot = entries.length;
      for (const cut of taken) {
        if (shown.has(cut)) continue;
        const edit: SavedEdit = { changeId: change.id, spot: spot++, label: LEFT_OUT, range: cut.range, version: change.toVersion, previous: [],
          beforeCut: { version: beforeVersion, removed: cut.removed }, kind: "cut", ...(change.reason && { reason: change.reason }),
          ...(found && { resaved: true }) };
        raise(edit, flagOn(change, edit.spot));
        edits.push(edit);
      }
    }
  }
  return edits;
}

/** A saved edit as it is listed, without what only placing it on the working cut needs. */
const listed = ({ version: _version, named: _named, still: _still, resaved: _resaved, putBack: _putBack,
  markerSays: _markerSays, reviewLocation: _reviewLocation, ...edit }: SavedEdit): Omit<ThreadEdit, "at"> => edit;

/** The edits one applied change made, in its own clock, as History lists them under its version. */
export function changeEdits(change: Change): Omit<ThreadEdit, "at">[] {
  return savedEdits({ changes: [change] } as Pick<Thread, "changes"> as Thread, () => true).map(listed)
    .sort((a, b) => (a.beforeCut?.removed.start ?? a.range.start) - (b.beforeCut?.removed.start ?? b.range.start));
}

/**
 * Every applied edit in a thread, from its saved changes, with each revision in the place of the edit it replaces.
 * It sorts by each change's own clock, so it only approximates the timeline's order and includes undone work:
 * show it until threadTimeline's list for the working cut arrives, and number edits from that.
 */
export function threadEditList(thread: Thread, media?: ProjectFiles): Omit<ThreadEdit, "at">[] {
  return savedEdits(thread, () => true, undefined, 30, media).map(listed)
    .sort((a, b) => a.range.start - b.range.start);
}

type ReviewVersionLink = Parameters<typeof historyLineage>[0][number] & { createdAt?: string };

const CLOCK = /\b(?:\d+:)?\d+:[0-5]\d(?:\.\d+)?(?![\d:]|\.\d)/g;
const seconds = (clock: string) => clock.split(":").reduce((total, part) => total * 60 + Number(part), 0);

/**
 * The span a flag's own words name inside the passage it flagged, and the words without those times. On Matt's pass a
 * flag on "Pricing and model names" gave the whole 56 seconds of it as its passage, and its words said where the doubt
 * was: "Check the ends of ‘GLM 5.3’ and the Lithos pickup and prices at 18:58.5–19:01.6" (2026-11-16). Every time it
 * names must fall in that passage, so a time about something else, or the source recording, leaves it as flagged.
 */
function namedSpan(check: string, flagged: TimeRange): { range: TimeRange; says: string } | undefined {
  if (/\b(?:source|raw)\b/i.test(check)) return;
  const times = [...check.matchAll(CLOCK)].map(match => seconds(match[0]));
  if (!times.length || times.some(t => t < flagged.start - 0.5 || t > flagged.end + 0.5)) return;
  const range = { start: Math.max(flagged.start, Math.min(...times)), end: Math.min(flagged.end, Math.max(...times)) };
  const time = CLOCK.source;
  const says = check.replace(new RegExp(`\\s*(?:\\b(?:at|around|near|from|between)\\s+)?${time}(?:\\s*(?:–|—|-|to|and)\\s*${time})?`, "gi"), "")
    .replace(/\(\s*\)/g, "").replace(/\s+([.,;:!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
  return { range, says };
}

/** Older flags can name a single explicit timeline time in their check without storing its version. */
function reviewTimeIn(check: string) {
  const matches = [...check.matchAll(/\b(?:\d+:)?\d+:[0-5]\d(?:\.\d+)?(?![\d:]|\.\d)/g)];
  if (matches.length !== 1) return;
  const match = matches[0]!;
  const before = check.slice(0, match.index);
  const after = check.slice(match.index + match[0].length);
  if (!/\b(?:at|near|around)\s+$/i.test(before) || /\b(?:source|raw)\b/i.test(before) ||
      /^\s+(?:in|on|of)\s+(?:the\s+)?(?:source|raw)\b/i.test(after)) return;
  return match[0].split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

/**
 * Whether `head` plays all the footage `before` plays through `span`, picture and sound each on a track of its kind.
 * Read clip by clip and not through a time map: the version that shows a cut's footage can lay the sound that
 * followed the cut under the picture it put back, and a map then finds that stretch on the working cut by its sound.
 */
function playsAll(before: Timeline, span: TimeRange, head: Timeline, fps: number) {
  const slack = 1 / fps;
  let any = false;
  for (const track of before.tracks) for (const clip of track.clips) {
    if (!("mediaId" in clip)) continue;
    let placed: TimeRange;
    try { placed = clipRange(clip); } catch { continue; }
    const from = Math.max(span.start, placed.start), to = Math.min(span.end, placed.end);
    if (to - from <= slack / 2) continue;
    any = true;
    const speed = clip.speed ?? 1;
    const need = { start: clip.sourceIn + (from - placed.start) * speed, end: clip.sourceIn + (to - placed.start) * speed };
    const have = head.tracks.filter(other => other.kind === track.kind).flatMap(other => other.clips)
      .flatMap(other => "mediaId" in other && other.mediaId === clip.mediaId ? [{ start: other.sourceIn, end: other.sourceOut }] : [])
      .sort((x, y) => x.start - y.start);
    let reach = need.start;
    for (const piece of have) {
      if (piece.end <= reach) continue;
      if (piece.start > reach + slack) break;
      reach = piece.end;
    }
    if (reach < need.end - slack) return false;
  }
  return any;
}

/** Return playable ranges on the working cut, never mixing clocks from different versions or branches. */
export function threadTimeline(thread: Thread, head: Timeline, links: ReviewVersionLink[],
  readVersion: (version: string) => Timeline | undefined, fps: number, media?: ProjectFiles): ThreadEdit[] {
  const { lineage, undone } = historyLineage(links, head.version);
  const duration = timelineDuration(head);
  if (!duration) return [];
  const timelines = new Map<string, Timeline | undefined>();
  const read = (version: string) => {
    if (!timelines.has(version)) timelines.set(version, version === head.version ? head : readVersion(version));
    return timelines.get(version);
  };
  const edits = savedEdits(thread, v => !undone.has(v) && (v === head.version || lineage.has(v)), read, fps, media);
  const maps = new Map<string, ReturnType<typeof makeTimeMap> | null>([[head.version, t => t]]);
  const mapFrom = (version: string) => {
    if (!maps.has(version)) {
      const source = read(version);
      maps.set(version, source ? makeTimeMap(source, head, fps) : null);
    }
    return maps.get(version);
  };
  const linksByVersion = new Map(links.map(link => [link.version, link]));
  const legacyLocation = (check: string, flaggedAt: string) => {
    const time = reviewTimeIn(check);
    if (time === undefined) return;
    const raised = Date.parse(flaggedAt);
    for (const version of lineage) {
      const createdAt = linksByVersion.get(version)?.createdAt;
      if (!createdAt || Date.parse(createdAt) > raised) continue;
      const source = read(version);
      if (source && time <= timelineDuration(source)) return { version, range: { start: time, end: time } };
      return;
    }
  };
  const placeReview = (edit: ThreadEdit, location?: SavedEdit["reviewLocation"]) => {
    if (!edit.check || edit.at !== undefined || edit.beforeCut || edit.kind === "cut" || edit.marker) return;
    const saved = location ?? (edit.recheck && legacyLocation(edit.check, edit.recheck));
    if (!saved) return;
    const map = mapFrom(saved.version);
    if (!map) return;
    // The editor checks what the words point at, and the card says where that is now.
    const named = location && namedSpan(edit.check, location.range);
    const flagged = named?.range ?? saved.range;
    const point = flagged.start === flagged.end;
    const start = map(flagged.start, "right") ?? map(flagged.start, "left");
    const end = point ? start : map(flagged.end, "left") ?? map(flagged.end, "right");
    if (start === null && end === null) return;
    const from = start ?? end!;
    const to = end ?? from;
    // A legacy time may refer to something outside this edit. A structured location was validated when saved.
    if (to < from || from < 0 || to > duration || (!location && (from < edit.range.start || to > edit.range.end))) return;
    return { range: { start: from, end: to }, says: named?.says };
  };
  const result: ThreadEdit[] = [];
  // A request that saves the video again often lists every edit it has made so far, not only what that save changed:
  // a dialogue pass saved three times listed the same 100 edits three times, and "N need you" counted each flagged one
  // once per save (2026-11-11). An edit Scarlet names again, under the same words at the same place on the working
  // cut, is the edit already listed. It keeps its first identity, which is the change that made it and plays its
  // Before and After, and takes the latest reason to look.
  const listedAs = new Map<string, Array<{ at: number; changeId: string; edit: ThreadEdit }>>();
  // A run that saves the video again also words the edits it lists again: on Matt's pass each save named the same
  // 2.1 seconds of a cube solve it had held, flagged, as "Kept the cube solve animation", then "Held the cube solve
  // animation", then "Held the cube solve", and with the reason to look said again in other words. Each listed as a
  // new edit to check, so keeping it brought the next one up (2026-11-16). A flagged edit its own run names again on
  // the very same footage is the edit already listed, whatever the words, and asks nothing new: the editor's answer
  // stands. A doubt a later request raises, or one about an edit its save moved or changed, still asks again.
  const runOf = new Map(thread.changes.map(item => [item.id, item.taskId]));
  const sameRun = (a: ThreadEdit, b: ThreadEdit) => !!runOf.get(a.changeId) && runOf.get(a.changeId) === runOf.get(b.changeId);
  // A save's kind for a stretch says what that save did there, so the hold read as "restore" in the save that put its
  // footage back. What's in the video is the same; a zoom, a caption or a sound fix on those frames is another edit.
  const footageKind = (kind: ThreadEdit["kind"]) => !kind || kind === "cut" || kind === "restore" || kind === "other" ? "footage" : kind;
  const sameFootage = (a: ThreadEdit, b: ThreadEdit) => footageKind(a.kind) === footageKind(b.kind) &&
    Math.abs(a.range.start - b.range.start) <= 1 / fps && Math.abs(a.range.end - b.range.end) <= 1 / fps;
  const restated = (first: ThreadEdit, later: ThreadEdit) => !!first.check && !!later.check && !later.recheck &&
    first.changeId !== later.changeId && sameRun(first, later) && sameFootage(first, later);
  const flaggedSoFar: ThreadEdit[] = [];
  const sameAs = (edit: ThreadEdit, named: boolean | undefined) => {
    if (!named || edit.previous.length) return undefined;
    const words = edit.label.trim().toLowerCase(), at = edit.at ?? edit.range.start;
    const listed = listedAs.get(words) ?? [];
    const same = listed.find(other => other.changeId !== edit.changeId && Math.abs(other.at - at) <= SAME_PLACE)?.edit ??
      flaggedSoFar.find(other => restated(other, edit));
    if (!same) {
      listedAs.set(words, [...listed, { at, changeId: edit.changeId, edit }]);
      if (edit.check) flaggedSoFar.push(edit);
    }
    return same;
  };
  // A pass also names cuts an earlier save of its request made, to say they need a look: on Matt's interview the cut
  // of "This is, what do I say?" was made by one save and flagged by the next, and showed as two edits, the flagged one
  // with no footage to show (2026-11-11). An edit named on a join where its own save moved nothing is the cut already there.
  const note = (first: ThreadEdit, later: ThreadEdit) => {
    // Two things one save named on the same edit are both said, as they are for a cut it made itself.
    const sameSave = first.reviewChangeId === later.changeId;
    if (later.check || later.summary || later.reason) first.reviewChangeId = later.changeId;
    if (later.check) {
      const changed = later.check !== first.check && !restated(first, later);
      if (changed) first.reviewRef = { changeId: later.changeId, spot: later.spot };
      if (changed || later.recheck) {
        first.recheck = later.recheck;
        if (first.at === undefined && !first.beforeCut && first.kind !== "cut" && !first.marker) first.reviewRange = later.reviewRange;
      }
      first.check = later.check;
      if (later.reviewSays) first.reviewSays = later.reviewSays;
      else delete first.reviewSays;
    }
    if (later.todo) first.todo = later.todo;
    if (later.summary) first.summary = sameSave && first.summary && first.summary !== later.summary ? `${first.summary} ${later.summary}` : later.summary;
    if (later.reason) first.reason = sameSave && first.reason && first.reason !== later.reason ? `${first.reason} ${later.reason}` : later.reason;
  };
  const cutThere = (edit: ThreadEdit) => result.find(other => other.beforeCut && other.changeId !== edit.changeId &&
    Math.abs(other.at! - edit.at!) <= NAMED_SLACK);
  // A pass that listens back to its cut saves the video again with a join moved a few frames: on Matt's DeepSeek
  // video each such save put a breath back or took a little more out at a cut the pass had made, and showed as an
  // edit of its own, "Added" at a single point on a red line (2026-11-14). A save that only moved the join of a cut
  // already listed revised that cut. The cut keeps its identity and its row, takes the save's sentence and reason to
  // look, and what it removed is read again from the working cut, in the clock of the version it was cut from.
  const backMaps = new Map<string, ReturnType<typeof makeTimeMap> | null>();
  const backTo = (version: string) => {
    if (!backMaps.has(version)) {
      const source = read(version);
      backMaps.set(version, source ? makeTimeMap(head, source, fps) : null);
    }
    return backMaps.get(version);
  };
  // Where the working cut jumps in its footage. Two clips that carry on from one another are not a join.
  const joins = [...new Set(head.tracks.flatMap(track => {
    const placed = track.clips.flatMap(clip => {
      try { return [{ clip, ...clipRange(clip) }]; } catch { return []; }
    }).sort((x, y) => x.start - y.start);
    return placed.flatMap((item, i) => {
      const last = placed[i - 1], next = placed[i + 1];
      const carriesOn = (x: typeof item, y: typeof item) => Math.abs(y.start - x.end) <= 1e-6 && "mediaId" in x.clip && "mediaId" in y.clip &&
        x.clip.mediaId === y.clip.mediaId && Math.abs(y.clip.sourceIn - x.clip.sourceOut) <= 0.5 / fps;
      return [...(last && carriesOn(last, item) ? [] : [item.start]), ...(next && carriesOn(item, next) ? [] : [item.end])];
    });
  }))].sort((x, y) => x - y);
  /** The joins within `slack` of a time, nearest first: it was named or mapped a hair off one and so sits inside the clip beside it. */
  const joinsNear = (t: number, slack = NAMED_SLACK) => {
    let low = 0, high = joins.length;
    while (low < high) { const mid = (low + high) >> 1; if (joins[mid]! < t - slack) low = mid + 1; else high = mid; }
    const near: number[] = [];
    for (let i = low; i < joins.length && joins[i]! <= t + slack; i++) near.push(joins[i]!);
    return near.sort((x, y) => Math.abs(x - t) - Math.abs(y - t));
  };
  const joinNear = (t: number, slack = NAMED_SLACK) => joinsNear(t, slack)[0];
  const removedAt = (cut: ThreadEdit, join: number): TimeRange | undefined => {
    const back = backTo(cut.beforeCut!.version), { removed } = cut.beforeCut!;
    const start = back?.(join, "left"), end = back?.(join, "right");
    if (typeof start !== "number" || typeof end !== "number" || end - start <= 0.5 / fps) return;
    return start < removed.end && end > removed.start ? { start, end } : undefined;
  };
  /** The cuts other saves made with their joins in `span`, latest first. */
  const cutsIn = (edit: ThreadEdit, span: TimeRange) => result.filter(cut => cut.beforeCut && cut.at !== undefined && cut.changeId !== edit.changeId &&
    cut.at >= span.start - NAMED_SLACK && cut.at <= span.end + NAMED_SLACK).reverse();
  /**
   * The latest of those cuts, moved to where one of `at` shows what it still removes. A save that swapped one take for
   * another leaves the cut between them with its join somewhere else, so with no cut at the place itself (`span`
   * left out) it is the latest cut anywhere that took out footage still missing there.
   */
  const revised = (edit: ThreadEdit, at: number[], span?: TimeRange) => {
    const cuts = span ? cutsIn(edit, span) : result.filter(cut => cut.beforeCut && cut.at !== undefined && cut.changeId !== edit.changeId).reverse();
    // Each track has its own joins, and a save can roll one track's edge a frame and leave another's: on Matt's pass the
    // camera's join after “modeling,” moved and the screen's didn't, so the nearest join read as no cut at all (2026-11-20).
    for (const cut of cuts) for (const t of at) for (const join of [...joinsNear(t), t]) {
      const removed = removedAt(cut, join);
      if (!removed) continue;
      cut.at = join;
      cut.range = withHandles({ start: join, end: join }, 1.5, duration);
      cut.beforeCut = { ...cut.beforeCut!, removed };
      return cut;
    }
  };
  /** A cut whose footage the stretch `span` of the working cut plays again, all of it: the cut is no longer in the video. */
  const putBackWhole = (edit: ThreadEdit, span: TimeRange) => cutsIn(edit, span).find(cut => {
    const back = backTo(cut.beforeCut!.version), { removed } = cut.beforeCut!;
    const start = back?.(span.start, "right"), end = back?.(span.end, "left");
    return typeof start === "number" && typeof end === "number" && start <= removed.start + 0.5 / fps && end >= removed.end - 0.5 / fps;
  });
  // Where each reason to look was raised, for a flag whose cut has since left the video (see the end).
  const flaggedAt = new Map<string, NonNullable<SavedEdit["reviewLocation"]>>();
  for (const { version, named, still, resaved, putBack, markerSays: _markerSays, reviewLocation, ...edit } of edits) {
    const map = mapFrom(version);
    if (!map) continue;
    const backStart = putBack && (map(putBack.start, "right") ?? map(putBack.start, "left"));
    const backEnd = putBack && (map(putBack.end, "left") ?? map(putBack.end, "right"));
    const back = typeof backStart === "number" && typeof backEnd === "number" && backEnd > backStart ? { start: backStart, end: backEnd } : undefined;
    // Footage put back and since taken out again is not in the video, as with any edit whose footage is gone.
    if (putBack && !back) continue;
    if (back && !edit.rejected) {
      // Footage put back on the left of a join leaves the join at its end, and on the right at its start.
      const trimmed = revised(edit, [back.end, back.start], back);
      if (trimmed) {
        note(trimmed, edit);
        continue;
      }
      // Putting back all a cut of this request took out leaves the video as it was there: neither is an edit to it.
      const gone = putBackWhole(edit, back);
      if (gone) {
        result.splice(result.indexOf(gone), 1);
        continue;
      }
    }
    // Named at a point, footage put back is still a stretch of the video, and is drawn as one.
    if (back && edit.range.start === edit.range.end) edit.range = putBack!;
    const point = edit.range.end === edit.range.start;
    const right = map(edit.range.start, "right"), left = point || right === null ? map(edit.range.start, "left") : null;
    // Footage put back since on the right of a join moved the frame after it along. The join is where the frame before it ends.
    const start = point && right !== null && left !== null && left < right - 1e-6 && joinNear(left, 1e-4) !== undefined && joinNear(right, 1e-4) === undefined
      ? left : right ?? left;
    const end = point ? start : map(edit.range.end, "left");
    if (start === null || end === null || start > end + 1e-6 || start > duration) continue;
    if (edit.range.end > edit.range.start && end <= start) continue;
    const range = { start: Math.max(0, start), end: Math.min(duration, Math.max(start, end)) };
    // A removal has a join but no surviving frames of its own. Audition the join with context.
    const placed: ThreadEdit = range.end === range.start ? { ...edit, at: range.start, range: withHandles(range, 1.5, duration) } : { ...edit, range };
    const review = placeReview(placed, reviewLocation);
    if (review) placed.reviewRange = review.range;
    if (review?.says) placed.reviewSays = review.says;
    if (placed.check && reviewLocation) flaggedAt.set(placed.check, reviewLocation);
    // A rejected edit is listed where it was, as it was: it is no part of another edit.
    if (placed.rejected) {
      result.push(placed);
      continue;
    }
    const first = (resaved && placed.at !== undefined ? revised(placed, [placed.at], { start: placed.at, end: placed.at }) ?? revised(placed, [placed.at]) : undefined) ??
      (still && placed.at !== undefined ? cutThere(placed) : undefined) ?? sameAs(placed, named);
    if (first) {
      note(first, placed);
      continue;
    }
    // A point has no footage of its own to call added. One named where the save re-made a join is an edit at that join.
    if (placed.at !== undefined && placed.kind === "restore") placed.kind = "other";
    result.push(placed);
  }
  // A cut is in the video while footage it took out is missing from it. A pass can put a cut's footage back with a save
  // of the whole timeline that never names the cut: one trimmed a pause that held the “5.5” of “Opus 5.5”, put the words
  // back three saves later as “Restored the complete Opus 5.5 model name”, and the cut stayed listed, red on the
  // timeline over words the video played, carrying a flag raised about the join beside it (2026-11-16). A cut whose
  // footage the working cut plays again, all of it, is not listed. A reason to look it carried goes to the cut that is
  // at the flagged place now, kept under the flag's own identity, or stays as a passage to check when there is none.
  const playsAgain = (cut: ThreadEdit) => {
    const { version, removed } = cut.beforeCut!, before = read(version);
    // A version that reads as the working cut's own tracks has nothing taken out to compare.
    return !!before && before.tracks !== head.tracks && removed.end - removed.start > 0.5 / fps && playsAll(before, removed, head, fps);
  };
  const gone = new Set(result.filter(edit => edit.beforeCut && edit.at !== undefined && playsAgain(edit)));
  for (const cut of gone) {
    if (!cut.check) continue;
    const location = flaggedAt.get(cut.check), map = location && mapFrom(location.version);
    const from = map && (map(location.range.start, "right") ?? map(location.range.start, "left"));
    const to = map && (map(location.range.end, "left") ?? map(location.range.end, "right"));
    const flagged = typeof from === "number" && typeof to === "number" && to >= from ? { start: from, end: to } : cut.range;
    const there = result.findLast(other => !gone.has(other) && other.beforeCut && other.at !== undefined && !other.check &&
      other.at >= flagged.start - NAMED_SLACK && other.at <= flagged.end + NAMED_SLACK);
    if (there) {
      there.check = cut.check;
      if (cut.recheck) there.recheck = cut.recheck;
      if (cut.reviewSays) there.reviewSays = cut.reviewSays;
      there.reviewRef = cut.reviewRef ?? { changeId: cut.changeId, spot: cut.spot };
      there.reviewChangeId = cut.reviewChangeId ?? cut.changeId;
    } else {
      // Nothing is cut there now: what is left to check is how the passage plays.
      gone.delete(cut);
      delete cut.beforeCut;
      delete cut.at;
      cut.kind = "other";
      cut.range = flagged.end > flagged.start ? flagged : cut.range;
      cut.reviewRange = cut.range;
    }
  }
  return result.filter(edit => !gone.has(edit)).sort((a, b) => (a.at ?? a.range.start) - (b.at ?? b.range.start));
}
