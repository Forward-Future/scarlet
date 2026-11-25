/**
 * Footage the timeline shows that the playing side doesn't have: another cut in the same pass took it out.
 * A skipped gap greys out and hands a click to `onGap`. On Before it's outlined and a click opens its edit.
 */
export interface TimelineGap {
  start: number;
  end: number;
  /** On the gap: "Cut at 2:05". */
  label: string;
  /** On a gap too narrow at this zoom for `label`: "2:05". */
  shortLabel?: string;
  /** The hover note's heading: which cut, and how long. */
  title: string;
  summary?: string;
  skipped: boolean;
  /** A cut of a call still waiting on the editor, shown as staged: amber, as its dot is. */
  call?: boolean;
  /** Opens the edit that made this cut. On Before, clicking a dotted cut opens it instead of scrubbing. */
  open?(): void;
}

/** Minimum clickable width, in pixels, so a narrow sliver cut can still be aimed at and clicked. */
export const MIN_GAP_HIT = 16;

/**
 * The visible gap under pointer position `x` (pixels from the track's left edge).
 * Prefers a gap that strictly contains `x` (choosing the narrowest when two touch or overlap so a small sliver beside
 * a wider cut still wins), then falls back to the nearest narrow gap within `MIN_GAP_HIT`.
 */
export function gapAt(gaps: readonly TimelineGap[], from: number, span: number, width: number, x: number): TimelineGap | undefined {
  if (!gaps.length || span <= 0 || width <= 0) return undefined;
  let inside: { gap: TimelineGap; w: number; dist: number } | undefined;
  let near: { gap: TimelineGap; dist: number } | undefined;
  for (const gap of gaps) {
    const left = Math.max(0, (gap.start - from) / span) * width;
    const right = Math.min(1, (gap.end - from) / span) * width;
    if (right <= 0 || left >= width || right <= left) continue;
    const w = right - left;
    const dist = Math.abs(x - (left + right) / 2);
    if (x >= left && x <= right) {
      if (!inside || w < inside.w - 0.5 || (Math.abs(w - inside.w) <= 0.5 && dist < inside.dist)) inside = { gap, w, dist };
    } else if (w < MIN_GAP_HIT && dist <= MIN_GAP_HIT / 2) {
      if (!near || dist < near.dist) near = { gap, dist };
    }
  }
  return inside?.gap ?? near?.gap;
}

/** A gap's tag is 10.5 px text with 6 px of padding each side, 3 px in from the gap's edges. */
const gapLabelWidth = (label: string) => label.length * 6 + 18;

/** A short label is narrower per letter than the estimate above allows for, and must not be dropped while it still fits. */
const shortLabelWidth = (label: string) => label.length * 5 + 18;

/**
 * The gap's label if it fits the gap's width in pixels, else its short one, else none: a label cut off mid-word reads as
 * a mistake, and hovering the gap still names its edit. Before the track is measured, the full label.
 */
export function gapLabel(gap: Pick<TimelineGap, "label" | "shortLabel">, px: number) {
  if (!(px > 0) || px >= gapLabelWidth(gap.label) || !gap.shortLabel) return gap.label;
  return px >= shortLabelWidth(gap.shortLabel) ? gap.shortLabel : "";
}

/**
 * The open edit's label on its band, the same way: whole if it fits, else the amount after its "·", else none. A short
 * cut's band is a few dozen pixels wide, and "Rem…" on it says nothing; the card over the timeline says what it is.
 */
export function bandLabel(label: string, px: number) {
  if (!(px > 0) || px >= gapLabelWidth(label)) return label;
  const amount = label.includes(" · ") ? label.slice(label.lastIndexOf(" · ") + 3) : "";
  return amount && px >= shortLabelWidth(amount) ? amount : "";
}

export interface TimelineDot {
  time: number;
  /** "Cut at 0:42" */
  title: string;
  summary?: string;
  /** Where it runs and for how long, or how much came out. */
  detail?: string;
  /** The request or change the edit came from. */
  context?: string;
  /**
   * Which kind of marker the dot is. Dots of different groups never share a marker: a call waiting on the editor and an
   * applied edit each keep their own. Edits have none.
   */
  group?: string;
  state?: "kept" | "check";
  /** What the hover note calls it while it waits on the editor, as "Cut at 2:47 needs you". Only such a dot has a note. */
  need?: string;
  /** The edit or call that's open. Its marker is lit, at the start of its band while that is on the timeline. */
  current?: boolean;
  /** The applied edit the dot stands for ("changeId/spot"), so it isn't drawn a second time under the dot. */
  edit?: string;
  /** Opens the edit. A press on its marker does this instead of starting a scrub. */
  open?(): void;
  /** The edit was applied a moment ago: its marker arrives with a moment, a cut's red closing up into it first. */
  landed?: "cut" | "edit";
  /** When it was applied (ms, as Date.now()). A marker drawn again mid-moment picks the moment up where it is. */
  landedAt?: number;
  /** The editor rejected the edit a moment ago: its marker shrinks away where it is. */
  leaving?: boolean;
}

/** A marker is a plain dot with no number or time on it: hovering it says when it is. One edit is a 9 px dot; edits
 *  that share a marker are a 15 px pill. */
const DOT = 9;
const PILL = 15;
const markWidth = (several: boolean) => several ? PILL : DOT;
export const MARK_GAP = 3;
/** How finely the zoom slider moves. */
export const ZOOM_STEPS = 1000;
/** A move of the playhead this far, in seconds or as a share of what the timeline shows, is a jump it glides through. */
export const GLIDE_FROM_SECONDS = 0.75;
export const GLIDE_FROM_SHARE = 0.03;
/** How long a glide takes, in ms: the same as the playhead's transition in workspace.css. */
export const GLIDE_MS = 260;
/** How far from a marker, in pixels, hovering the strip still picks it. */
const MARK_SNAP = 24;
/** A pill's run reaches at most this many pixels along the track, so a dense pass reads as several pills that each zoom
 *  to a stretch worth seeing, not as one pill for all of it. */
const RUN_REACH = 104;
/** How long an edit's arrival plays, in ms: a cut's red closing (.26 s) and then the marker's ring (.7 s). */
export const LANDING_PLAYS = 1000;

export interface MarkLayout {
  /** Names the marker: its group and its first edit's time. */
  key: string;
  /** The first edit's time. */
  time: number;
  /** Every time the marker stands for. */
  times: number[];
  dots: TimelineDot[];
  at: number;
  width: number;
}

export function isPill({ dots }: MarkLayout) {
  const first = dots[0]!;
  return dots.some(dot => dot.time !== first.time);
}

/** Each edit draws as its dot. Dots that would touch at this zoom share one pill, so there are never more markers than
 *  fit and none hides another. A run reaches at most RUN_REACH: the next
 *  edit starts a run of its own, moved along just clear of the one before if it would touch it. The open edit keeps its
 *  own circle the same way. Only circles of one
 *  group share: a call's and an edit's each keep their own. Before the track is measured, nothing is shared.
 *  `groupSpan` is the stretch the runs are worked out for, which a zoom on its way gives so its pills don't change on
 *  the way there; positions are always for `span`. */
export function layoutMarks(marks: TimelineDot[], from: number, span: number, width: number, groupSpan = span) {
  if (span <= 0) return [];
  // Dots of different groups at one time are different markers, so they're gathered apart from the start.
  const byTime = new Map<string, TimelineDot[]>();
  for (const mark of marks) {
    if (!(mark.time >= from && mark.time <= from + span)) continue;
    const key = `${mark.group ?? ""}@${mark.time}`;
    const dots = byTime.get(key);
    if (dots) dots.push(mark); else byTime.set(key, [mark]);
  }
  const position = (time: number) => (time - from) / span * 100;
  // How far apart two times are, in pixels, at the zoom the runs are for.
  const px = (a: number, b: number) => groupSpan > 0 ? (b - a) / groupSpan * width : 0;
  const marker = (key: string, time: number, dots: TimelineDot[]) => {
    const layout: MarkLayout = { key, time, times: [time], dots, at: position(time), width: markWidth(false) };
    return { layout };
  };
  // The distance between two markers' centres, in pixels at the zoom the runs are for, counting a run moved along.
  const centreGap = (a: MarkLayout, b: MarkLayout) => px(mid(a), mid(b)) + (shift.get(b) ?? 0) - (shift.get(a) ?? 0);
  const mid = (m: MarkLayout) => (m.times[0]! + m.times.at(-1)!) / 2;
  const shift = new Map<MarkLayout, number>();
  const circles = new Map<string, ReturnType<typeof marker>[]>();
  for (const [key, dots] of [...byTime].sort((a, b) => a[1][0]!.time - b[1][0]!.time)) {
    const time = dots[0]!.time;
    let next = marker(key, time, dots);
    const row = circles.get(dots[0]!.group ?? "") ?? [];
    circles.set(dots[0]!.group ?? "", row);
    // A marker joins the run before it when its first edit's circle would touch that run's last, or the two markers
    // would touch, as long as the run doesn't reach too far.
    const crowded = (a: MarkLayout, b: MarkLayout) => px(a.times.at(-1)!, b.times[0]!) < DOT + MARK_GAP
      || centreGap(a, b) < a.width / 2 + b.width / 2 + MARK_GAP;
    for (let before = row.at(-1); width > 0 && before && crowded(before.layout, next.layout); before = row.at(-1)) {
      // A run that would reach too far stays apart, moved along just clear of the one before if it would touch it. So
      // does the edit that's open: its own dot is lit at the start of its band, in no pill.
      const open = (m: MarkLayout) => m.dots.some(dot => dot.current);
      if (px(before.layout.times[0]!, next.layout.times.at(-1)!) > RUN_REACH || open(before.layout) || open(next.layout)) {
        const clear = before.layout.width / 2 + next.layout.width / 2 + MARK_GAP;
        if (centreGap(before.layout, next.layout) < clear) shift.set(next.layout, (shift.get(before.layout) ?? 0) - px(mid(before.layout), mid(next.layout)) + clear);
        break;
      }
      // Sharing widens the pill and moves it, so it can reach the marker before it too.
      row.pop();
      const group = before.layout;
      for (const t of next.layout.times) group.times.push(t);
      for (const dot of next.layout.dots) group.dots.push(dot);
      group.width = markWidth(isPill(group));
      // Its middle has moved: whether it still needs moving along is worked out again against the run before it.
      shift.delete(next.layout);
      shift.delete(group);
      next = before;
    }
    row.push(next);
  }
  // A marker sits at the middle of its run, moved along if it had to be, and never past the track's ends. Clamping at
  // either end pushes crowded neighbours aside rather than letting the clamped pill land on top of the one beside it.
  // Near 0:00, leave a small margin clear of the playhead stem so a dot or pill at the start never sits on top of it.
  const startInset = 4;
  const placeRow = (row: ReturnType<typeof marker>[]) => {
    if (width <= 0) return row.map(({ layout }) => layout);
    const natural = row.map(({ layout }) => (mid(layout) - from) / span * width);
    const xs = row.map(({ layout }, i) => natural[i]! + (shift.get(layout) ?? 0));
    const minLeft = (half: number) => Math.min(width - half, half + startInset);
    const keepInside = (i: number) => {
      const m = row[i]!.layout;
      const half = m.width / 2;
      return m.times.length > 1 || m.dots.length > 1 || shift.has(m) || xs[i] !== natural[i]
        || natural[i]! < minLeft(half) || natural[i]! > width - half;
    };
    for (let i = 0; i < row.length; i++) {
      const half = row[i]!.layout.width / 2;
      if (keepInside(i) && xs[i]! < minLeft(half)) xs[i] = minLeft(half);
      if (i > 0 && groupSpan >= span) {
        const clear = row[i - 1]!.layout.width / 2 + half + MARK_GAP;
        if (xs[i]! < xs[i - 1]! + clear) xs[i] = xs[i - 1]! + clear;
      }
    }
    for (let i = row.length - 1; i >= 0; i--) {
      const half = row[i]!.layout.width / 2;
      if (keepInside(i) && xs[i]! > width - half) xs[i] = width - half;
      if (i < row.length - 1 && groupSpan >= span) {
        const clear = half + row[i + 1]!.layout.width / 2 + MARK_GAP;
        if (xs[i]! > xs[i + 1]! - clear) xs[i] = xs[i + 1]! - clear;
      }
    }
    for (let i = 0; i < row.length; i++) {
      const half = row[i]!.layout.width / 2;
      if (keepInside(i) && xs[i]! < minLeft(half)) xs[i] = minLeft(half);
    }
    return row.map(({ layout }, i) => ({ ...layout, at: xs[i]! / width * 100 }));
  };
  const placed = [...circles.values()].flatMap(placeRow).sort((a, b) => a.at - b.at);
  // Markers from different groups never merge into one pill, and still must not draw on top of each other.
  if (width > 0 && groupSpan >= span && circles.size > 1 && placed.length > 1) {
    const xs = placed.map(m => m.at / 100 * width);
    for (let i = 1; i < placed.length; i++) {
      const clear = placed[i - 1]!.width / 2 + placed[i]!.width / 2 + MARK_GAP;
      if (xs[i]! < xs[i - 1]! + clear) xs[i] = xs[i - 1]! + clear;
    }
    for (let i = placed.length - 1; i >= 0; i--) {
      const half = placed[i]!.width / 2;
      if (xs[i]! > width - half) xs[i] = width - half;
      if (i < placed.length - 1) {
        const clear = half + placed[i + 1]!.width / 2 + MARK_GAP;
        if (xs[i]! > xs[i + 1]! - clear) xs[i] = xs[i + 1]! - clear;
      }
    }
    for (let i = 0; i < placed.length; i++) {
      const half = placed[i]!.width / 2;
      const minX = Math.min(width - half, half + startInset);
      if (xs[i]! < minX) xs[i] = minX;
    }
    return placed.map((m, i) => ({ ...m, at: xs[i]! / width * 100 }));
  }
  return placed;
}

/** A hit prefers the visible marker: the open edit, then a pill drawn over another group's circle. */
export function nearestMark(layout: MarkLayout[], percent: number, width: number) {
  let nearest: MarkLayout | undefined, visible: MarkLayout | undefined;
  let distance = Infinity, visibleDistance = Infinity, visiblePriority = -1;
  for (const mark of layout) {
    const delta = Math.abs(mark.at - percent);
    if (delta < distance) { nearest = mark; distance = delta; }
    if (delta * width / 100 > mark.width / 2) continue;
    const priority = mark.dots.some(dot => dot.current) ? 2 : isPill(mark) ? 1 : 0;
    if (priority > visiblePriority || (priority === visiblePriority && delta <= visibleDistance)) {
      visible = mark;
      visibleDistance = delta;
      visiblePriority = priority;
    }
  }
  return visible ?? (nearest && distance * width / 100 <= Math.max(MARK_SNAP, nearest.width / 2) ? nearest : undefined);
}

export function dotState(dots: TimelineDot[]) {
  if (dots.some(d => d.state === "check")) return "check";
  return dots.length && dots.every(d => d.state === "kept") ? "kept" : undefined;
}
