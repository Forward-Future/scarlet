/**
 * The edits a thread's applied changes made, each in the clock of the version that saved it. `threadTimeline` places
 * them on the working cut.
 */
import { appliedReviewChange, cutKindRow, intervalCandidates, removedJoins, reviewCutSummaries, timelineDuration, reviewKindRows, reviewReasons, type Change, type CutAssessment, type MediaAsset, type Timeline, type TimeRange } from "@scarlet/timeline";
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
   * Scarlet changed nothing here: it named the spot to ask the editor to check it, such as where it stayed on the camera
   * because the screen recording didn't show what was said. Its row and card say Check.
   */
  onlyCheck?: true;
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
  /**
   * The edit was flagged for the editor (`check`) before it was rejected. `check` is cleared so nothing treats a
   * rejected edit as still waiting, while `wasCheck` keeps its row in For you, marked Rejected.
   */
  wasCheck?: true;
}

/** The editor's words for a rejection Scarlet was asked to make, in the chat and in the queue. */
export const REJECT_MESSAGE = "Reject edit";

/** A request the × on an edit's card sent: the editor wrote nothing, and what Scarlet is told is its instruction. */
export const isRejectRequest = (task: { instruction?: string; context: { message?: string } }) =>
  task.context.message === REJECT_MESSAGE && task.instruction !== REJECT_MESSAGE;

/** The editor's words for a to-do Scarlet was asked to add, in the chat and in the queue. */
export const ADD_MESSAGE = "Add it";

/** A request Add on a to-do's card sent: the editor wrote nothing, and what Scarlet is told is its instruction. */
export const isAddRequest = (task: { instruction?: string; context: { message?: string } }) =>
  task.context.message === ADD_MESSAGE && task.instruction !== ADD_MESSAGE;

/** Why a revision of a flagged edit asks for a look when Scarlet gave it no reason of its own. */
export const REVISED_CHECK = "Revised";

export function matchesEdit(edit: ThreadEdit, ref: EditRef) {
  return (edit.changeId === ref.changeId && edit.spot === ref.spot) ||
    edit.previous.some(item => item.changeId === ref.changeId && item.spot === ref.spot);
}

export interface SavedEdit extends ThreadEdit {
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

/** A cut Scarlet named no edit for, in a video it built from the pieces to keep. The engine names its row by its words. */
export const LEFT_OUT = "Cut";

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
export const NAMED_SLACK = 0.05;

/** Greedily match candidate `(spot, cut)` pairs nearest-first, one cut per spot. */
function matchNearestJoins(pairs: Array<{ spot: number; cut: Cut; off: number }>) {
  pairs.sort((a, b) => a.off - b.off);
  const joins = new Map<number, Cut>();
  const taken = new Set<Cut>();
  for (const { spot, cut } of pairs) {
    if (joins.has(spot) || taken.has(cut)) continue;
    joins.set(spot, cut);
    taken.add(cut);
  }
  return { joins, taken };
}

/**
 * The join each ranged cut was named around. A cut has no playback of its own, so it is often named by the second or
 * so either side of its join: footage that stayed, which the timeline would draw as kept. Each such edit takes the
 * join nearest its middle. One whose range still holds a join no edit took made several cuts, and stays a range.
 */
function rangedJoins(ranges: TimeRange[], kinds: EditKind[], cuts: Cut[]) {
  if (!ranges.some((r, spot) => r.end > r.start && kinds[spot] === "cut")) return new Map<number, Cut>();
  // A join an edit named as a point takes is that edit's, found within the same hundredth as namedJoins finds it, so
  // the footage it removed is counted once.
  const claimed = new Set(namedJoins(ranges, cuts).values());
  const free = cuts.filter(cut => !claimed.has(cut));
  const candidates = intervalCandidates(free, cut => cut.range.start, cut => cut.range.start);
  const pairs = ranges.flatMap((range, spot) => range.end > range.start && kinds[spot] === "cut"
    ? candidates(range.start - NAMED_SLACK, range.end + NAMED_SLACK).map(cut => ({ spot, cut, off: Math.abs((range.start + range.end) / 2 - cut.range.start) })) : []);
  const { joins, taken } = matchNearestJoins(pairs);
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
    ? candidates(range.start - NAMED_SLACK, range.start + NAMED_SLACK).map(cut => ({ spot, cut, off: Math.abs(range.start - cut.range.start) })) : []);
  return matchNearestJoins(pairs).joins;
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
export type ProjectFiles = readonly Pick<MediaAsset, "id" | "kind" | "source">[];

/** Carry over prior identity, review check, and marker to-do state when `edit` replaces `replaced`. */
function inheritReplacedEdit(edit: SavedEdit, replaced: SavedEdit, rejected = false) {
  edit.previous = [...replaced.previous, { changeId: replaced.changeId, spot: replaced.spot }];
  if (!rejected && replaced.check && !edit.check) edit.check = REVISED_CHECK;
  if (edit.marker && replaced.todo && (!edit.todo || edit.todo === edit.markerSays)) edit.todo = replaced.todo;
}

/** Project the conversation's changes into distinct edit identities before translating their times. */
export function savedEdits(thread: Pick<Thread, "changes"> & Partial<Pick<Thread, "tasks" | "flagged">>, visible: (version: string) => boolean, read?: (version: string) => Timeline | undefined, fps = 30, media?: ProjectFiles) {
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
    for (const edit of savedEdits({ changes: [change] }, visible, read, fps, media)) {
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
      inheritReplacedEdit(edit, edits[prior]!);
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
    // A change that built the video from the pieces to keep never had the rest on its timeline. The engine read what
    // it left out between them once it was applied, with a version that plays it.
    // A change that took its footage out as cuts, with or without the fades that smooth them, is read from those.
    const rippled = dialogue ?? (!change.approvedSpots && !change.appliedReview ? dialogueEdits(change, true) : undefined);
    // What a save took out doesn't depend on how Scarlet made it or on its naming its edits: one model names every
    // cut, another saves the video with one sentence about it, another trims and moves clips step by step. A save
    // nothing else reads is read from the versions either side of it (2026-11-23).
    const unnamed = !named && !dialogue && !change.approvedSpots && !change.appliedReview;
    // A first cut saved whole names no edits: every stretch of the recording it left out is one of its cuts, and they
    // are all it did. Listed as one row for the whole video, Matt's 28-minute recording cut to 15 showed none of its
    // 104 cuts and the request said 20 s had come out (2026-11-23).
    const whole = unnamed && !rippled && !!change.firstCut && !change.ops?.length;
    const built = (named || unnamed) && !rippled && change.leftOut?.version && change.leftOut.joins.length
      ? { version: change.leftOut.version, joins: change.leftOut.joins } : undefined;
    // A save of the whole video has no steps to read. What it took out and put back is read from the versions either side.
    const saved = (named || unnamed) && !rippled && !built && read ? { before: read(change.fromVersion), after: read(change.toVersion) } : undefined;
    const sides = saved?.before && saved.after ? { before: saved.before, after: saved.after } : undefined;
    const lost = sides && removedJoins(sides.before, sides.after, fps);
    // A save made of steps is read so only when they took footage out and left the video shorter: its edits are
    // otherwise read from the steps. Steps that slide a picture a few frames to sit with its sound took nothing out.
    const shorter = sides && timelineDuration(sides.after) < timelineDuration(sides.before) - 0.5 / fps;
    const found = sides && (!change.ops?.length || (lost!.length && shorter)) ? sides : undefined;
    // What the change says it did is about the footage it placed ("Kept the complete opening"), so a stretch it left
    // out and named nothing for goes by what it is.
    const taken = (found ? lost : built?.joins)?.map((join): Cut => ({ label: built || unnamed ? LEFT_OUT : change.description,
      range: { start: join.at, end: join.at }, removed: join.removed, replaces: undefined }));
    const returned = taken && found ? removedJoins(found.after, found.before, fps).map(join => join.removed) : undefined;
    const cuts = rippled ?? taken;
    const removals = new Map(cuts?.map(cut => [cut.range.start, cut]));
    const reasons = change.appliedReview && reviewReasons(change, change.appliedReview.joins);
    const summaries = change.appliedReview && reviewCutSummaries(change, change.appliedReview.joins);
    const kindRows = change.appliedReview && reviewKindRows(change, change.appliedReview.joins);
    const cutNotes = appliedCutNotes(change);
    const approved = approvedNotes(change, applied);
    const entries = named ?? (whole && built ? [] : applied.ranges).map((range, index) => {
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
      if (named && classified.nothing[spot] && kind === "other" && !edit.marker && edit.check) edit.onlyCheck = true;
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
        const isRejected = rejects(change);
        inheritReplacedEdit(edit, replaced, isRejected);
        // A rejected edit keeps its own words on its row, which then says it was rejected: nothing is left to check.
        if (isRejected) {
          edit.rejected = true;
          // The engine's own put-back is named as the row was when the editor rejected it, which for a cut is the words
          // beside it (`cutRowWords`): the saved label would turn its row back into "Shortened a pause". What Scarlet
          // put back, it named itself ("Restored…"), so that one reads as the edit it took out.
          if (!change.rejects) edit.label = replaced.label;
          if (replaced.summary) edit.summary = replaced.summary; else delete edit.summary;
          if (replaced.reason) edit.reason = replaced.reason; else delete edit.reason;
          if (replaced.check || replaced.wasCheck) edit.wasCheck = true;
          delete edit.check;
        }
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
  return savedEdits({ changes: [change] }, () => true).map(listed)
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
