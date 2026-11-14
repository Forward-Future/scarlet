import { appliedReviewChange, clipRange, historyLineage, intervalCandidates, makeTimeMap, removedJoins, reviewReasons, timelineDuration, withHandles, type Change, type Timeline, type TimeRange } from "@scarlet/timeline";
import type { Thread } from "./threads.js";
import { editKinds, type EditKind } from "./editKind.js";

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
  /** A later change that supplied the review note for this same edit on the working cut. */
  reviewChangeId?: string;
  /**
   * The later edit whose reason to look this one now carries. It asks something new of an edit the editor may already
   * have kept or called, so keeping it is recorded under this identity and not the edit's own.
   */
  reviewRef?: EditRef;
  /** Scarlet's one sentence on what the edit did. Its card shows this alone. */
  summary?: string;
  /** What the edit did, so the timeline draws a cut, a sound fix or a zoom each for what it is. */
  kind?: EditKind;
  /**
   * When a later run raised `check` about this edit, already in the video. Keeping the edit before then doesn't
   * settle that doubt.
   */
  recheck?: string;
  /** Another request made this edit. It is listed here because this request found a doubt about it. */
  elsewhere?: true;
}

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
  /** Scarlet named this edit itself, in the list it saved with its change, as against a cut read from what was removed. */
  named?: boolean;
  /** Named at a point where its own save neither took footage out nor put any back. */
  still?: boolean;
  /** Named at a point by a save of the whole video, which can move the join of a cut that an earlier save made. */
  resaved?: boolean;
  /** The footage this edit's save put back where the edit was named, in the clock of the version it saved. */
  putBack?: TimeRange;
}

/** A cut Scarlet named no edit for, in a video it built from the pieces to keep. */
const LEFT_OUT = "Cut";

/** How far apart, in seconds on the working cut, two named edits can sit and still be the same place. */
const SAME_PLACE = 1;

const TIMING_KEYS = new Set(["sourceIn", "sourceOut", "timelineIn", "timelineOut", "speed"]);

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
  const result: { label: string; range: TimeRange; removed: TimeRange; replaces?: EditRef; check?: string }[] = [];
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
    if (!skipped?.has(call)) result.push({ label: own ? own.reason : change.description,
      range: { start: at, end: at }, removed: { start: op.start, end: op.end }, replaces: undefined, ...(own?.check && { check: own.check }) });
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
  const points = new Set(ranges.filter(r => r.start === r.end).map(r => r.start));
  const free = cuts.filter(cut => !points.has(cut.range.start));
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
  if (cuts && change.ops?.length === change.cutReasons?.length) return cuts.map(({ label, range, check }) => ({ label, range, ...(check && { check }) }));
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

/** Project the conversation's changes into distinct edit identities before translating their times. */
function savedEdits(thread: Thread, visible: (version: string) => boolean, read?: (version: string) => Timeline | undefined, fps = 30) {
  const edits: SavedEdit[] = [];
  // The latest doubt this request's runs raised about an edit already in the video (`Change.flags`).
  const runs = new Set(thread.tasks?.map(t => t.id));
  const flagOn = (change: Change, spot: number) => change.flags?.findLast(f => f.spot === spot && runs.has(f.taskId));
  const raise = (edit: SavedEdit, flag: NonNullable<Change["flags"]>[number] | undefined) => {
    if (!flag) return;
    edit.check = flag.check;
    edit.recheck = flag.at;
  };
  // An edit another request made comes first, as it was in the video before this request's own: a revision this
  // request then makes of it takes its place.
  for (const change of thread.flagged ?? []) {
    for (const edit of savedEdits({ changes: [change] } as Pick<Thread, "changes"> as Thread, visible, read, fps)) {
      const flag = flagOn(change, edit.spot);
      if (!flag) continue;
      raise(edit, flag);
      edit.elsewhere = true;
      edits.push(edit);
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
    const removals = new Map(cuts?.map(cut => [cut.range.start, cut.removed]));
    const reasons = change.appliedReview && reviewReasons(change, change.appliedReview.joins);
    const entries = named ?? applied.ranges.map((range, index) => ({
      range, label: reasons?.[index]?.join(" · ") || change.description, replaces: undefined,
    }));
    const ranges = entries.map(e => e.range);
    // A pure pass already computed the joins on its finished clock. Skipped calls are absent from that list.
    const rippleJoins = dialogue && !change.restoredCuts?.length ? dialogue : undefined;
    const clocks = !rippleJoins && read ? { before: read(change.appliedOnto ?? change.fromVersion), after: read(appliedVersion) } : undefined;
    const fromSteps = editKinds(change, ranges, clocks, rippleJoins ?? (taken && returned && [...taken,
      ...returned.map(range => ({ range, facet: "restore" as const }))]));
    // What a built change's steps say is that footage was placed. An edit named on a join where footage was left out is a cut.
    const kinds = built && taken ? fromSteps.map((kind, spot) => taken.some(cut => cut.range.start >= ranges[spot]!.start - NAMED_SLACK &&
      cut.range.start <= ranges[spot]!.end + NAMED_SLACK) ? "cut" : kind) : fromSteps;
    const joins = named && cuts ? rangedJoins(ranges, kinds, cuts) : undefined;
    const atJoin = taken?.length ? namedJoins(ranges, taken) : undefined;
    const beforeVersion = change.appliedReview?.originalVersion ?? built?.version ?? change.fromVersion;
    const shown = new Map<Cut, SavedEdit>();
    for (const [spot, item] of entries.entries()) {
      const joined = joins?.get(spot) ?? atJoin?.get(spot);
      const range = joined?.range ?? item.range;
      const edit: SavedEdit = { changeId: change.id, spot, label: item.label, range,
        version: named ? change.toVersion : appliedVersion, previous: [], ...(named && change.timelineEdits?.length && { named: true }) };
      const check = "check" in item ? item.check : undefined;
      if (check) edit.check = check;
      const summary = "summary" in item ? item.summary : undefined;
      if (summary) edit.summary = summary;
      raise(edit, flagOn(change, spot));
      // Two things Scarlet named on the one join are one cut: its row says both, and the footage is counted once.
      const shared = built && !joined && kinds[spot] === "cut" && taken ? taken.find(cut => shown.has(cut) &&
        cut.range.start >= item.range.start - NAMED_SLACK && cut.range.start <= item.range.end + NAMED_SLACK) : undefined;
      const first = shared && shown.get(shared);
      if (first && !item.replaces) {
        if (summary && summary !== first.summary) first.summary = first.summary ? `${first.summary} ${summary}` : summary;
        if (check && !first.check) first.check = check;
        continue;
      }
      if (built && joined) shown.set(joined, edit);
      const sameSpot = cuts?.[spot];
      const removed = change.appliedReview?.joins[spot]?.removed ?? joined?.removed ??
        (sameSpot?.range.start === range.start ? sameSpot.removed : removals.get(range.start));
      if (removed && range.start === range.end) edit.beforeCut = { version: beforeVersion, removed };
      const kind = edit.beforeCut ? "cut" : kinds[spot];
      if (kind) edit.kind = kind;
      if (found && edit.named && kind === "other" && range.start === range.end) edit.still = true;
      if (found && edit.named && range.start === range.end) edit.resaved = true;
      const back = edit.named && kind === "restore" ? returned?.filter(r => r.start <= range.end + NAMED_SLACK && r.end >= range.start - NAMED_SLACK) : undefined;
      if (back?.length) edit.putBack = { start: Math.min(...back.map(r => r.start)), end: Math.max(...back.map(r => r.end)) };
      const prior = item.replaces ? edits.findIndex(e => matchesEdit(e, item.replaces!)) : -1;
      if (prior >= 0) {
        const replaced = edits[prior]!;
        edit.previous = [...replaced.previous, { changeId: replaced.changeId, spot: replaced.spot }];
        // The editor sent back an edit that was theirs to check, so its new version is theirs to check too, whether
        // or not Scarlet flagged it again. The old reason was about the old version.
        if (replaced.check && !edit.check) edit.check = REVISED_CHECK;
        edits[prior] = edit;
      } else edits.push(edit);
    }
    // The stretches it left out that Scarlet named no edit for are cuts all the same, listed after the ones it named.
    if (built && taken) {
      let spot = entries.length;
      for (const cut of taken) {
        if (shown.has(cut)) continue;
        const edit: SavedEdit = { changeId: change.id, spot: spot++, label: cut.label, range: cut.range, version: change.toVersion, previous: [],
          beforeCut: { version: built.version, removed: cut.removed }, kind: "cut" };
        raise(edit, flagOn(change, edit.spot));
        edits.push(edit);
      }
    }
  }
  return edits;
}

/** The edits one applied change made, in its own clock, as History lists them under its version. */
export function changeEdits(change: Change): Omit<ThreadEdit, "at">[] {
  return savedEdits({ changes: [change] } as Pick<Thread, "changes"> as Thread, () => true).map(({ version: _version, named: _named, still: _still, resaved: _resaved, putBack: _putBack, ...edit }) => edit)
    .sort((a, b) => (a.beforeCut?.removed.start ?? a.range.start) - (b.beforeCut?.removed.start ?? b.range.start));
}

/**
 * Every applied edit in a thread, from its saved changes, with each revision in the place of the edit it replaces.
 * It sorts by each change's own clock, so it only approximates the timeline's order and includes undone work:
 * show it until threadTimeline's list for the working cut arrives, and number edits from that.
 */
export function threadEditList(thread: Thread): Omit<ThreadEdit, "at">[] {
  return savedEdits(thread, () => true).map(({ version: _version, named: _named, still: _still, resaved: _resaved, putBack: _putBack, ...edit }) => edit)
    .sort((a, b) => a.range.start - b.range.start);
}

/** Return playable ranges on the working cut, never mixing clocks from different versions or branches. */
export function threadTimeline(thread: Thread, head: Timeline, links: Parameters<typeof historyLineage>[0],
  readVersion: (version: string) => Timeline | undefined, fps: number): ThreadEdit[] {
  const { lineage, undone } = historyLineage(links, head.version);
  const duration = timelineDuration(head);
  if (!duration) return [];
  const timelines = new Map<string, Timeline | undefined>();
  const read = (version: string) => {
    if (!timelines.has(version)) timelines.set(version, version === head.version ? head : readVersion(version));
    return timelines.get(version);
  };
  const edits = savedEdits(thread, v => !undone.has(v) && (v === head.version || lineage.has(v)), read, fps);
  const maps = new Map<string, ReturnType<typeof makeTimeMap> | null>([[head.version, t => t]]);
  const result: ThreadEdit[] = [];
  // A request that saves the video again often lists every edit it has made so far, not only what that save changed:
  // a dialogue pass saved three times listed the same 100 edits three times, and "N need you" counted each flagged one
  // once per save (2026-11-11). An edit Scarlet names again, under the same words at the same place on the working
  // cut, is the edit already listed. It keeps its first identity, which is the change that made it and plays its
  // Before and After, and takes the latest reason to look.
  const listedAs = new Map<string, Array<{ at: number; changeId: string; edit: ThreadEdit }>>();
  const sameAs = (edit: ThreadEdit, named: boolean | undefined) => {
    if (!named || edit.previous.length) return undefined;
    const words = edit.label.trim().toLowerCase(), at = edit.at ?? edit.range.start;
    const listed = listedAs.get(words) ?? [];
    const same = listed.find(other => other.changeId !== edit.changeId && Math.abs(other.at - at) <= SAME_PLACE);
    if (!same) listedAs.set(words, [...listed, { at, changeId: edit.changeId, edit }]);
    return same?.edit;
  };
  // A pass also names cuts an earlier save of its request made, to say they need a look: on Matt's interview the cut
  // of "This is, what do I say?" was made by one save and flagged by the next, and showed as two edits, the flagged one
  // with no footage to show (2026-11-11). An edit named on a join where its own save moved nothing is the cut already there.
  const note = (first: ThreadEdit, later: ThreadEdit) => {
    // Two things one save named on the same edit are both said, as they are for a cut it made itself.
    const again = first.reviewChangeId === later.changeId && first.summary && later.summary && first.summary !== later.summary;
    if (later.check || later.summary) first.reviewChangeId = later.changeId;
    if (later.check && later.check !== first.check) first.reviewRef = { changeId: later.changeId, spot: later.spot };
    if (later.check) first.check = later.check;
    if (later.summary) first.summary = again ? `${first.summary} ${later.summary}` : later.summary;
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
  /** The join within `slack` of a time, which was named or mapped a hair off it and so sits inside the clip beside it. */
  const joinNear = (t: number, slack = NAMED_SLACK) => {
    let low = 0, high = joins.length;
    while (low < high) { const mid = (low + high) >> 1; if (joins[mid]! < t) low = mid + 1; else high = mid; }
    return [joins[low - 1], joins[low]].filter((join): join is number => join !== undefined && Math.abs(join - t) <= slack)
      .sort((x, y) => Math.abs(x - t) - Math.abs(y - t))[0];
  };
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
    for (const cut of cuts) for (const t of at) {
      const join = joinNear(t) ?? t, removed = removedAt(cut, join);
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
  for (const { version, named, still, resaved, putBack, ...edit } of edits) {
    if (!maps.has(version)) {
      const source = read(version);
      maps.set(version, source ? makeTimeMap(source, head, fps) : null);
    }
    const map = maps.get(version);
    if (!map) continue;
    const backStart = putBack && (map(putBack.start, "right") ?? map(putBack.start, "left"));
    const backEnd = putBack && (map(putBack.end, "left") ?? map(putBack.end, "right"));
    const back = typeof backStart === "number" && typeof backEnd === "number" && backEnd > backStart ? { start: backStart, end: backEnd } : undefined;
    // Footage put back and since taken out again is not in the video, as with any edit whose footage is gone.
    if (putBack && !back) continue;
    if (back) {
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
      // Named at a point, footage put back is still a stretch of the video, and is drawn as one.
      if (edit.range.start === edit.range.end) edit.range = putBack!;
    }
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
  return result.sort((a, b) => (a.at ?? a.range.start) - (b.at ?? b.range.start));
}
