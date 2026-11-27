import { clipRange, firstIndex, historyLineage, makeTimeMap, timelineDuration, withHandles, type Change, type Clip, type Timeline, type TimeRange } from "@scarlet/timeline";
import type { Thread } from "./threads.js";
import { filterSupersededEdits, NAMED_SLACK, savedEdits, type ProjectFiles, type SavedEdit, type ThreadEdit } from "./threadEdits.js";

/** How far apart, in seconds on the working cut, two named edits can sit and still be the same place. */
const SAME_PLACE = 1;

/** Map a range onto the working cut using inclusive side fallbacks at each edge. */
function mapRange(map: ReturnType<typeof makeTimeMap>, range: TimeRange): { start: number | null; end: number | null } {
  const start = map(range.start, "right") ?? map(range.start, "left");
  const end = range.start === range.end ? start : map(range.end, "left") ?? map(range.end, "right");
  return { start, end };
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
  const matches = [...check.matchAll(CLOCK)];
  if (matches.length !== 1) return;
  const match = matches[0]!;
  const before = check.slice(0, match.index);
  const after = check.slice(match.index + match[0].length);
  if (!/\b(?:at|near|around)\s+$/i.test(before) || /\b(?:source|raw)\b/i.test(before) ||
      /^\s+(?:in|on|of)\s+(?:the\s+)?(?:source|raw)\b/i.test(after)) return;
  return seconds(match[0]);
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
  readVersion: (version: string) => Timeline | undefined, fps: number, media?: ProjectFiles, projectChanges?: readonly Change[]): ThreadEdit[] {
  const { lineage, undone } = historyLineage(links, head.version);
  const duration = timelineDuration(head);
  if (!duration) return [];
  const timelines = new Map<string, Timeline | undefined>();
  const read = (version: string) => {
    if (!timelines.has(version)) timelines.set(version, version === head.version ? head : readVersion(version));
    return timelines.get(version);
  };
  const visible = (v: string) => !undone.has(v) && (v === head.version || lineage.has(v));
  const lineageDepth = new Map<string, number>();
  const lineageList = [...lineage];
  for (let i = 0; i < lineageList.length; i++) lineageDepth.set(lineageList[i]!, lineageList.length - 1 - i);
  const isAfter = (other: Change, origin: Change) => {
    const a = lineageDepth.get(other.appliedVersion ?? other.toVersion);
    const b = lineageDepth.get(origin.appliedVersion ?? origin.toVersion);
    if (a !== undefined && b !== undefined && a !== b) return a > b;
    return (Date.parse(other.createdAt ?? "") || 0) > (Date.parse(origin.createdAt ?? "") || 0);
  };
  const edits = filterSupersededEdits(
    savedEdits(thread, visible, read, fps, media, projectChanges),
    thread,
    visible,
    projectChanges,
    isAfter,
    read,
  );
  const headClips = new Map<string, Clip>();
  for (const track of head.tracks) for (const clip of track.clips) {
    if (!headClips.has(clip.id)) headClips.set(clip.id, clip);
  }
  const currentClipSpan = (placedClips: SavedEdit["placedClips"]): TimeRange | undefined => {
    if (!placedClips?.length) return;
    let start = Infinity, end = -Infinity;
    for (const placed of placedClips) {
      const clip = headClips.get(placed.id);
      if (!clip || clip.enabled === false) continue;
      if (placed.mediaId !== undefined && (clip.kind !== "media" || clip.mediaId !== placed.mediaId)) continue;
      try {
        const r = clipRange(clip);
        start = Math.min(start, r.start);
        end = Math.max(end, r.end);
      } catch { /* ignore invalid clip bounds */ }
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    const clamped = { start: Math.max(0, start), end: Math.min(duration, end) };
    return clamped.end > clamped.start ? clamped : undefined;
  };
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
    const { start, end } = mapRange(map, flagged);
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
    const low = firstIndex(joins, j => j >= t - slack);
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
  const adrift: Omit<ThreadEdit, "at">[] = [];
  /** Cuts named on a join their save re-made (`resaved`): that save moved a cut already there, and may have taken nothing out. */
  const reshaped = new Set<ThreadEdit>();
  /** Places of a save Scarlet named no edit for where the video plays as it did (`quiet`): they finished other edits. */
  const quietly = new Set<ThreadEdit>();
  for (const { version, named, still, resaved, putBack, markerSays: _markerSays, markerIds: _markerIds, placedClips, placedSpan, reviewLocation, quiet, ...edit } of edits) {
    const map = mapFrom(version);
    if (!map) continue;
    const mappedBack = putBack ? mapRange(map, putBack) : undefined;
    const back = mappedBack && typeof mappedBack.start === "number" && typeof mappedBack.end === "number" && mappedBack.end > mappedBack.start
      ? { start: mappedBack.start, end: mappedBack.end } : undefined;
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
    let start = point && right !== null && left !== null && left < right - 1e-6 && joinNear(left, 1e-4) !== undefined && joinNear(right, 1e-4) === undefined
      ? left : right ?? left;
    const mapped = point ? start : map(edit.range.end, "left");
    // Nothing plays before a version's start, so a cut there has no frame either side to follow to the working cut: it
    // is at the start for as long as its footage stays out (`playsAgain`). The talk before Matt's first line, 2:15 of a
    // 28-minute recording, went unlisted once picture sync had moved the first frame along (2026-11-23).
    const opening = point && !!edit.beforeCut && start === null && edit.range.start <= 0.5 / fps;
    const end = opening ? 0 : mapped;
    if (opening) start = 0;
    // A cut with no frame left either side of it: later cuts took those out too. Its footage is still out (see `adrift`).
    if (point && edit.beforeCut && !edit.rejected && start === null) adrift.push(edit);
    if (start === null || end === null || start > end + 1e-6 || start > duration) continue;
    if (edit.range.end > edit.range.start && end <= start) continue;
    const mappedRange = { start: Math.max(0, start), end: Math.min(duration, Math.max(start, end)) };
    const range = (!edit.rejected && !edit.beforeCut && !edit.marker && placedSpan ? currentClipSpan(placedClips) : undefined) ?? mappedRange;
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
    if (resaved) reshaped.add(placed);
    if (quiet) quietly.add(placed);
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
    const mapped = location && map ? mapRange(map, location.range) : undefined;
    const flagged = mapped && typeof mapped.start === "number" && typeof mapped.end === "number" && mapped.end >= mapped.start
      ? { start: mapped.start, end: mapped.end } : cut.range;
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
  // What the cuts say came out is what the working cut leaves out, counted once. Each cut is read in the clock of its
  // own version, so nothing ties two of them to the same footage: on Matt's talking head a save that took one flashed
  // frame from between two cuts read as a 7.3 s cut over footage five earlier cuts had already taken, three cuts
  // whose neighbours later cuts took out weren't listed at all, and two sat a few frames inside a clip, off the join
  // their footage is missing at. The request's total was 6 s out against a recording 13:10 shorter (2026-11-23).
  const listed = result.filter(edit => !gone.has(edit));
  const savedAt = new Map(thread.changes.map((item, i) => [item.id, i]));
  const order = (cut: ThreadEdit) => (savedAt.get(cut.changeId) ?? thread.changes.length) * 1e6 + cut.spot;
  const length = (range: TimeRange) => range.end - range.start;
  /** A stretch of a recording: what a join skips, or what a cut took out. */
  type Footage = { mediaId: string; start: number; end: number; from: number };
  type MediaPiece = { mediaId: string; timelineIn: number; sourceIn: number; sourceOut: number; speed: number; end: number };
  const piecesOf = (timeline: Timeline) => timeline.tracks.map(track => track.clips.flatMap((clip): MediaPiece[] => {
    if (clip.kind !== "media" || clip.enabled === false) return [];
    const speed = clip.speed ?? 1;
    return [{ mediaId: clip.mediaId, timelineIn: clip.timelineIn, sourceIn: clip.sourceIn, sourceOut: clip.sourceOut, speed, end: clip.timelineIn + (clip.sourceOut - clip.sourceIn) / speed }];
  }).sort((x, y) => x.timelineIn - y.timelineIn)).filter(track => track.length);
  // The footage the working cut skips at each place, track by track: before its first piece, between two pieces of one
  // recording, and after its last. A join in the picture is a few edges, one a track, a millisecond or a frame or two
  // apart (a crossfade moves the sound's), so the ones within two frames of each other are one place.
  const skips: Array<{ at: number; gap: Footage }> = [];
  for (const track of piecesOf(head)) {
    const first = track[0]!, last = track.at(-1)!;
    if (first.timelineIn <= 0.5 / fps) skips.push({ at: 0, gap: { mediaId: first.mediaId, start: -Infinity, end: first.sourceIn, from: 0 } });
    if (last.end >= duration - 2 / fps) skips.push({ at: duration, gap: { mediaId: last.mediaId, start: last.sourceOut, end: Infinity, from: 0 } });
    for (let i = 1; i < track.length; i++) {
      const left = track[i - 1]!, right = track[i]!;
      if (left.mediaId === right.mediaId && right.timelineIn - left.end <= 2 / fps && right.sourceIn - left.sourceOut > 0.5 / fps)
        skips.push({ at: right.timelineIn, gap: { mediaId: left.mediaId, start: left.sourceOut, end: right.sourceIn, from: 0 } });
    }
  }
  skips.sort((x, y) => x.at - y.at);
  type Spot = { start: number; end: number; gaps: Footage[] };
  const spots: Spot[] = [];
  for (const { at, gap } of skips) {
    const spot = spots.at(-1);
    if (spot && at - spot.end <= 2 / fps && at < duration - 0.5 / fps === spot.end < duration - 0.5 / fps && spot.start > 0.5 / fps === at > 0.5 / fps) {
      spot.end = at;
      spot.gaps.push(gap);
    } else spots.push({ start: at, end: at, gaps: [gap] });
  }
  const spotAt = (t: number) => spots.find(spot => t >= spot.start - 2 / fps && t <= spot.end + 2 / fps);
  /** The footage a cut took out, on each track of the version it was cut from. */
  const taken = new Map<ThreadEdit | Omit<ThreadEdit, "at">, Footage[][]>();
  const takenBy = (cut: ThreadEdit | Omit<ThreadEdit, "at">) => {
    if (!taken.has(cut)) {
      const { version, removed } = cut.beforeCut!, source = read(version);
      taken.set(cut, !source ? [] : piecesOf(source).map(track => track.flatMap((piece): Footage[] => {
        const from = Math.max(piece.timelineIn, removed.start), to = Math.min(piece.end, removed.end);
        return to - from > 1e-6 ? [{ mediaId: piece.mediaId, start: piece.sourceIn + (from - piece.timelineIn) * piece.speed, end: piece.sourceIn + (to - piece.timelineIn) * piece.speed, from }] : [];
      })));
    }
    return taken.get(cut)!;
  };
  /**
   * How much of what a cut took out the working cut still skips at a place, with where that is in the cut's version.
   * Each track is read against each track of the working cut: a picture moved a few frames to sit with its sound
   * skips the same seconds a little later in its recording.
   */
  const outAt = (cut: ThreadEdit | Omit<ThreadEdit, "at">, spot: Spot) => {
    let best: { seconds: number; range: TimeRange } | undefined;
    for (const track of takenBy(cut)) for (const gap of spot.gaps) {
      let seconds = 0, start = Infinity, end = -Infinity;
      for (const piece of track) {
        const from = Math.max(piece.start, gap.start), to = Math.min(piece.end, gap.end);
        if (piece.mediaId !== gap.mediaId || to - from <= 1e-6) continue;
        seconds += to - from;
        start = Math.min(start, piece.from + (from - piece.start));
        end = Math.max(end, piece.from + (to - piece.start));
      }
      if (seconds > (best?.seconds ?? 0.5 / fps)) best = { seconds, range: { start, end } };
    }
    return best;
  };
  const moveTo = (cut: ThreadEdit, spot: Spot) => {
    cut.at = spot.start;
    cut.range = withHandles({ start: cut.at, end: cut.at }, 1.5, duration);
  };
  const nearest = (cut: ThreadEdit | Omit<ThreadEdit, "at">, near: Spot[], from?: number) => near.map(spot => ({ spot, seconds: outAt(cut, spot)?.seconds ?? 0 }))
    .filter(found => found.seconds > 0.5 / fps)
    .sort((x, y) => y.seconds - x.seconds || (from === undefined ? 0 : Math.abs(x.spot.start - from) - Math.abs(y.spot.start - from)))[0]?.spot;
  // A cut the working cut has no frame beside, or one that sits inside a clip, is at the join its footage is missing at.
  for (const cut of adrift) {
    const spot = nearest(cut, spots);
    if (!spot) continue;
    const placed: ThreadEdit = { ...cut, at: spot.start };
    moveTo(placed, spot);
    listed.push(placed);
  }
  for (const cut of listed) {
    if (!cut.beforeCut || cut.at === undefined || cut.rejected || spotAt(cut.at)) continue;
    const spot = nearest(cut, spots, cut.at);
    if (spot) moveTo(cut, spot);
  }
  /**
   * Where everything `cuts` took out at `spot` plays in the version `into` was cut from, when that version plays it as
   * one stretch holding what `into` itself took out.
   */
  const wholeOut = (into: ThreadEdit, cuts: ThreadEdit[], spot: Spot): TimeRange | undefined => {
    const source = read(into.beforeCut!.version);
    if (!source) return;
    const out = cuts.flatMap(cut => takenBy(cut).flat()).flatMap(piece => spot.gaps.flatMap(gap => {
      const start = Math.max(piece.start, gap.start), end = Math.min(piece.end, gap.end);
      return gap.mediaId === piece.mediaId && end - start > 1e-6 ? [{ mediaId: gap.mediaId, start, end }] : [];
    }));
    const own = into.beforeCut!.removed;
    for (const track of piecesOf(source)) {
      const placed = track.flatMap(piece => out.flatMap(footage => {
        if (footage.mediaId !== piece.mediaId) return [];
        const from = Math.max(piece.sourceIn, footage.start), to = Math.min(piece.sourceOut, footage.end);
        return to - from > 1e-6 ? [{ start: piece.timelineIn + (from - piece.sourceIn) / piece.speed, end: piece.timelineIn + (to - piece.sourceIn) / piece.speed }] : [];
      })).sort((x, y) => x.start - y.start);
      if (!placed.length) continue;
      let reach = placed[0]!.start;
      if (placed.some(piece => {
        if (piece.start > reach + 1 / fps) return true;
        reach = Math.max(reach, piece.end);
        return false;
      })) continue;
      const whole = { start: placed[0]!.start, end: reach };
      if (whole.start <= own.start + 1 / fps && whole.end >= own.end - 1 / fps) return whole;
    }
  };
  /** `from`'s reason to look, on `into`, kept under `from`'s identity so keeping `into` before doesn't settle it. */
  const takeDoubt = (into: ThreadEdit, from: ThreadEdit) => {
    if (!from.check) return;
    into.check = into.check && into.check !== from.check ? `${into.check}${/[.!?]$/.test(into.check) ? " " : ". "}${from.check}` : from.check;
    if (from.recheck) into.recheck = from.recheck;
    if (from.reviewSays) into.reviewSays = from.reviewSays;
    into.reviewRef = from.reviewRef ?? { changeId: from.changeId, spot: from.spot };
    into.reviewChangeId = from.reviewChangeId ?? from.changeId;
  };
  /** Two cuts at one join said as one: both their reasons, and a reason to look either raised. */
  const joinWords = (into: ThreadEdit, from: ThreadEdit) => {
    const reason = into.reason && from.reason && !into.reason.includes(from.reason)
      ? `${into.reason}${/[.!?]$/.test(into.reason) ? " " : ". "}${from.reason}` : into.reason ?? from.reason;
    if (reason) into.reason = reason;
    if (from.check && from.check !== into.check) takeDoubt(into, from);
  };
  // The cuts at one join share the footage missing there. Each has what the join still skips of its own, the earliest
  // save first and a save that only reshaped a cut already there last. One left with nothing took nothing of its own
  // out: the cut before it takes its sentence and its reason to look.
  const atJoin = new Map<Spot, ThreadEdit[]>();
  for (const cut of listed) {
    const spot = cut.beforeCut && cut.at !== undefined && !cut.rejected ? spotAt(cut.at) : undefined;
    if (spot) atJoin.set(spot, [...atJoin.get(spot) ?? [], cut]);
  }
  const folded = new Set<ThreadEdit>();
  for (const [spot, cuts] of atJoin) {
    const skipped = Math.max(...spot.gaps.map(gap => gap.end - gap.start));
    let left = skipped, last: ThreadEdit | undefined;
    // Of the saves that reshaped it, one that asks for a look is read last, so its words and its reason stay together.
    for (const cut of cuts.sort((x, y) => Number(reshaped.has(x)) - Number(reshaped.has(y)) || (reshaped.has(x) ? Number(!!x.check) - Number(!!y.check) : 0) || order(x) - order(y))) {
      const { removed } = cut.beforeCut!, out = outAt(cut, spot);
      // A cut whose version doesn't show the join's footage is left as it is, with what it says it took.
      if (!out) { last = cut; continue; }
      const take = Math.min(out.seconds, length(removed), left);
      left -= take;
      if (take <= 0.5 / fps && last) {
        note(last, cut);
        folded.add(cut);
        continue;
      }
      if (take < length(removed) - 0.5 / fps) {
        // What is still out, where its own version shows it; otherwise that much from where it began.
        const still = out && Math.abs(length(out.range) - take) <= 1 / fps ? out.range : { start: removed.start, end: removed.start + take };
        cut.beforeCut = { ...cut.beforeCut!, removed: still };
      }
      last = cut;
    }
    // Saves that each took footage out at one join made one cut: the join plays once, and the editor keeps or rejects
    // what it leaves out as one. On Matt's "reimann 2" the first edit left out the talk before a take, a later save
    // took the first try at its line out beside it, and the list showed nine joins twice, each with half the footage
    // that went (2026-11-23). The earliest keeps its identity and shows it all, from its own version, when that version
    // plays it as one stretch.
    const each = cuts.filter(cut => !folded.has(cut) && !cut.elsewhere).sort((x, y) => order(x) - order(y));
    const removed = each.length > 1 ? wholeOut(each[0]!, each, spot) : undefined;
    if (removed) {
      const [into, ...rest] = each;
      // Its row says what the cut that took the most out said, which names the larger part of what went.
      const most = each.reduce((best, cut) => length(cut.beforeCut!.removed) > length(best.beforeCut!.removed) ? cut : best);
      into!.beforeCut = { ...into!.beforeCut!, removed };
      for (const cut of rest) {
        joinWords(into!, cut);
        folded.add(cut);
      }
      if (most.summary) into!.summary = most.summary;
      else delete into!.summary;
    }
  }
  // A save Scarlet named no edit for, where the video plays as it did (`quietly`), finished the edits round it: on
  // Matt's "reimann 2" a pass that had cut and placed the interviews then moved their sound to the dialogue track and
  // eased fourteen joins with two-frame fades, and the list showed nineteen more edits to look at, a frame or two each
  // at a join or the length of a clip already listed (2026-11-23). Such a place has no row. A doubt Scarlet raised
  // about it goes to the edit there, a cut whose join it is at before one it lies in or touches, and stays listed
  // when there is none.
  const near = 2 / fps;
  const stretchOf = (edit: ThreadEdit) => edit.at !== undefined ? { start: edit.at, end: edit.at } : edit.range;
  const others = listed.filter(edit => !folded.has(edit) && !quietly.has(edit) && !edit.rejected);
  for (const edit of listed) {
    if (!quietly.has(edit) || folded.has(edit) || edit.marker || edit.elsewhere || edit.previous.length) continue;
    if (edit.check) {
      const own = stretchOf(edit), spans = (other: ThreadEdit, slack: number) => {
        const it = stretchOf(other);
        return it.start <= own.end + slack && own.start <= it.end + slack;
      };
      const into = others.find(other => other.beforeCut && spans(other, near)) ??
        others.find(other => { const it = stretchOf(other); return it.start <= own.start + near && own.end <= it.end + near; }) ??
        others.find(other => spans(other, near));
      if (!into) continue;
      takeDoubt(into, edit);
    }
    folded.add(edit);
  }
  return listed.filter(edit => !folded.has(edit)).sort((a, b) => (a.at ?? a.range.start) - (b.at ?? b.range.start));
}
