import type { TimelineDot } from "./TimelineScrubber";

/**
 * Every applied edit on the working cut, drawn under what needs the editor: a cut is a thin red line at its join, a
 * graphic or other overlay a bar as long as it is on screen, a zoom, a reframe or a caption a dimmer bar, anything else a
 * small tick. Marks that would touch at this zoom gather into one count ("11 cuts · 2 graphics").
 */
export interface TimelineEdit extends TimelineDot {
  /** Names the edit among the others. */
  key: string;
  /** What the edit did (`EditKind`, or a kind added since). An unknown kind draws as a tick and counts as another edit. */
  kind?: string;
  /** Where it stops being on screen. A cut, or anything else that sits at one point, ends where it starts. */
  end: number;
}

export type EditShape = "cut" | "bar" | "dim" | "tick";

/** How each kind draws, and its words in a count. */
const KINDS: Record<string, { shape: EditShape; one: string; many: string }> = {
  cut: { shape: "cut", one: "cut", many: "cuts" },
  graphic: { shape: "bar", one: "graphic", many: "graphics" },
  overlay: { shape: "bar", one: "overlay", many: "overlays" },
  text: { shape: "dim", one: "caption", many: "captions" },
  zoom: { shape: "dim", one: "zoom", many: "zooms" },
  reframe: { shape: "dim", one: "reframe", many: "reframes" },
  audio: { shape: "tick", one: "audio edit", many: "audio edits" },
};
const OTHER = { shape: "tick" as EditShape, one: "other edit", many: "other edits" };
/** The order kinds are named in when a count holds as many of each. */
const ORDER = [...Object.keys(KINDS), "other"];

const kindOf = (edit: Pick<TimelineEdit, "kind">) => edit.kind && KINDS[edit.kind] ? edit.kind : "other";

/** A bar has length. A cut, and any other edit that sits at one point, draws as a line. */
export function editShape(edit: Pick<TimelineEdit, "kind" | "time" | "end">): EditShape {
  const shape = (KINDS[kindOf(edit)] ?? OTHER).shape;
  if (shape === "bar" || shape === "dim") return edit.end > edit.time ? shape : "tick";
  return shape;
}

/** What a count holds, by kind, most first: "9 cuts", "11 cuts · 2 graphics", "40 cuts · 3 zooms · 2 more". */
export function countLabel(edits: readonly Pick<TimelineEdit, "kind">[]) {
  const counts = new Map<string, number>();
  for (const edit of edits) counts.set(kindOf(edit), (counts.get(kindOf(edit)) ?? 0) + 1);
  const kinds = [...counts].sort((a, b) => b[1] - a[1] || ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
  const named = kinds.slice(0, 2).map(([kind, n]) => {
    const words = KINDS[kind] ?? OTHER;
    return `${n} ${n === 1 ? words.one : words.many}`;
  });
  const more = kinds.slice(2).reduce((sum, [, n]) => sum + n, 0);
  return [...named, ...more ? [`${more} more`] : []].join(" · ");
}

export interface EditLayout {
  key: string;
  /** A count of several edits, or one edit drawn for what it is. */
  shape: EditShape | "count";
  edits: TimelineEdit[];
  /** Where it starts, and a bar's end, in percent of what the timeline shows. A count is centred on `at`. */
  at: number;
  to: number;
  /** The stretch of the video a count's marks cover, a line by where it is drawn: a press zooms to it. */
  start: number;
  end: number;
  label?: string;
  /** Which lane along the top of the strip a bar runs in, from the top. */
  lane?: number;
  /** A count's width in pixels. */
  width: number;
}

/** A count is a pill sized to its text, like a run of numbered dots. */
const countWidth = (label: string) => Math.round(label.length * 6 + 14);
/** Lines closer than this, in pixels, would touch. */
const LINE_ROOM = 6;
/** Bars closer than this would touch. */
const BAR_ROOM = 4;
/** Bars that overlap run in up to this many lanes. */
const LANES = 3;
/** A bar shorter than this, in pixels, can't be told from the bar beside it. */
const SHORT_BAR = 10;
/** A count gathers the crowded marks within this many pixels of its first, so a stretch of many cuts reads as a few counts. */
const GATHER = 120;
const COUNT_GAP = 6;
/** How far from a line, in pixels, the pointer still reaches it. */
const LINE_REACH = 4;

interface Placed { edit: TimelineEdit; shape: EditShape; x0: number; x1: number }

/**
 * Lays out the applied edits in view. An edit with room draws for what it is. Edits that would touch gather, with the
 * crowded ones near them, into counts no wider than their words, and counts that would touch share one. A line that
 * would sit under a count joins it. Before the track is measured, nothing gathers.
 */
export function layoutEdits(edits: readonly TimelineEdit[], from: number, span: number, width: number,
  /** The markers of what needs the editor, by centre and width in pixels. A count steps aside from them. */
  above: readonly { x: number; w: number }[] = []): EditLayout[] {
  if (span <= 0) return [];
  const to = from + span;
  const px = (t: number) => (t - from) / span * width;
  const percent = (t: number) => (t - from) / span * 100;
  const lines: Placed[] = [], bars: Placed[] = [];
  for (const edit of edits) {
    const shape = editShape(edit);
    const point = shape === "cut" || shape === "tick";
    const end = point ? edit.time : edit.end;
    if (end < from || edit.time > to) continue;
    const placed = { edit, shape, x0: px(Math.max(from, edit.time)), x1: px(Math.min(to, end)) };
    (point ? lines : bars).push(placed);
  }
  const single = (p: Placed): EditLayout => ({ key: p.edit.key, shape: p.shape, edits: [p.edit], at: percent(Math.max(from, p.edit.time)),
    to: percent(Math.min(to, p.shape === "cut" || p.shape === "tick" ? p.edit.time : p.edit.end)), start: p.edit.time, end: p.edit.end, width: 0 });
  if (!(width > 0)) return [...lines, ...bars].map(single).sort((a, b) => a.at - b.at);
  lines.sort((a, b) => a.x0 - b.x0);
  bars.sort((a, b) => a.x0 - b.x0);
  // A mark is crowded when it would touch another of its row: lines along the strip, bars along the top of it.
  const crowded = new Set<Placed>();
  for (let i = 1; i < lines.length; i++) if (lines[i]!.x0 - lines[i - 1]!.x0 < LINE_ROOM) { crowded.add(lines[i]!); crowded.add(lines[i - 1]!); }
  // Bars that touch run in lanes along the top of the strip, one under another, so a graphic over a zoom or under a
  // caption that runs the whole video is still drawn. A run of bars that needs more lanes than there are, or that holds
  // a bar too short to read beside the others, gathers.
  const lane = new Map<Placed, number>();
  for (let i = 0; i < bars.length;) {
    let reach = bars[i]!.x1, j = i + 1;
    while (j < bars.length && bars[j]!.x0 <= reach + BAR_ROOM) reach = Math.max(reach, bars[j++]!.x1);
    const run = bars.slice(i, j);
    i = j;
    if (run.length === 1) { lane.set(run[0]!, 0); continue; }
    const ends: number[] = [];
    let fits = !run.some(bar => bar.x1 - bar.x0 < SHORT_BAR);
    for (const bar of run) {
      if (!fits) break;
      const free = ends.findIndex(end => end + BAR_ROOM < bar.x0);
      const at = free >= 0 ? free : ends.length;
      if (at >= LANES) fits = false;
      else { ends[at] = bar.x1; lane.set(bar, at); }
    }
    if (!fits) for (const bar of run) { lane.delete(bar); crowded.add(bar); }
  }
  // Crowded marks gather from left to right, each count reaching a little way past its first.
  type Count = { items: Placed[]; x0: number; x1: number; first: number };
  const counts: Count[] = [];
  const gathering = [...crowded].sort((a, b) => a.x0 - b.x0);
  // A count doesn't reach across a marker of what needs the editor: the marks either side of it gather apart.
  const markers = above.filter(a => a.w > 2).map(a => a.x);
  const across = (a: number, b: number) => markers.some(x => x > a && x <= b);
  for (const item of gathering) {
    const last = counts.at(-1);
    if (last && item.x0 - last.first < GATHER && !across(last.items.at(-1)!.x0, item.x0)) {
      last.items.push(item);
      last.x1 = Math.max(last.x1, item.x1);
    } else counts.push({ items: [item], x0: item.x0, x1: item.x1, first: item.x0 });
  }
  const box = (count: Count) => {
    const label = countLabel(count.items.map(i => i.edit));
    const w = countWidth(label);
    // A count sits over the middle of its marks, or of the part of a long bar in view.
    const centre = (Math.min(...count.items.map(i => i.x0)) + Math.min(width, Math.max(...count.items.map(i => i.shape === "bar" || i.shape === "dim" ? Math.min(i.x1, i.x0 + GATHER) : i.x1)))) / 2;
    return { label, w, centre: Math.min(width - w / 2, Math.max(w / 2, centre)) };
  };
  // Counts that would touch share one. A bar no longer than a count, which the count would hide, joins it. A line, or a
  // longer bar, runs on beneath it: taking in the lines it crosses would widen it over more, and swallow a stretch with room.
  const loose = [...lines, ...bars].filter(item => !crowded.has(item)).sort((a, b) => a.x0 - b.x0);
  const reachesUnder = (item: Placed, c: { centre: number; w: number }) => item.shape !== "cut" && item.shape !== "tick" &&
    item.x1 - item.x0 <= c.w && item.x1 >= c.centre - c.w / 2 - 2 && item.x0 <= c.centre + c.w / 2 + 2;
  let merged: (Count & ReturnType<typeof box>)[] = [];
  // Each mark that joins a count widens it, so the counts are shared out again until none is left under one.
  for (let round = 0; ; round++) {
    merged = [];
    for (const count of counts.sort((a, b) => a.x0 - b.x0)) {
      let next = { ...count, ...box(count) };
      for (let before = merged.at(-1); before && next.centre - before.centre < (before.w + next.w) / 2 + COUNT_GAP; before = merged.at(-1)) {
        merged.pop();
        const joined: Count = { items: [...before.items, ...next.items], x0: Math.min(before.x0, next.x0), x1: Math.max(before.x1, next.x1), first: before.first };
        next = { ...joined, ...box(joined) };
      }
      merged.push(next);
    }
    const under = loose.filter(item => merged.some(c => reachesUnder(item, c)));
    if (!under.length || round >= 8) break;
    for (const line of under) {
      loose.splice(loose.indexOf(line), 1);
      merged.reduce((best, c) => Math.abs(line.x0 - c.centre) < Math.abs(line.x0 - best.centre) ? c : best).items.push(line);
    }
    counts.splice(0, counts.length, ...merged.map(({ items, x0, x1, first }) => ({ items, x0: Math.min(x0, ...items.map(i => i.x0)), x1, first })));
  }
  // What needs the editor stays clear: a count under one of its markers moves to the nearer side of it, when there's
  // room there before the next count and the timeline's edge.
  const clear = [...above].filter(a => a.w > 2).sort((a, b) => a.x - b.x);
  merged.forEach((count, i) => {
    for (let tries = 0; tries < 4; tries++) {
      const hit = clear.find(a => Math.abs(a.x - count.centre) < (a.w + count.w) / 2 + COUNT_GAP);
      if (!hit) return;
      const left = hit.x - (hit.w + count.w) / 2 - COUNT_GAP, right = hit.x + (hit.w + count.w) / 2 + COUNT_GAP;
      const low = Math.max(count.w / 2, i ? merged[i - 1]!.centre + (merged[i - 1]!.w + count.w) / 2 + COUNT_GAP : -Infinity);
      const high = Math.min(width - count.w / 2, i < merged.length - 1 ? merged[i + 1]!.centre - (merged[i + 1]!.w + count.w) / 2 - COUNT_GAP : Infinity);
      const options = [left, right].filter(x => x >= low && x <= high).sort((a, b) => Math.abs(a - count.centre) - Math.abs(b - count.centre));
      if (!options.length) return;
      count.centre = options[0]!;
    }
  });
  const gathered = merged.map((count): EditLayout => {
    // A count left with one edit draws it for what it is.
    if (count.items.length === 1) return single(count.items[0]!);
    const groupEdits = count.items.map(i => i.edit).sort((a, b) => a.time - b.time);
    return { key: `count:${groupEdits[0]!.key}`, shape: "count", edits: groupEdits, at: count.centre / width * 100, to: count.centre / width * 100,
      start: groupEdits[0]!.time, end: Math.max(...count.items.map(i => i.shape === "cut" || i.shape === "tick" ? i.edit.time : i.edit.end)), label: count.label, width: count.w };
  });
  return loose.map(item => item.shape === "cut" || item.shape === "tick" ? single(item) : { ...single(item), lane: lane.get(item) ?? 0 })
    .concat(gathered).sort((a, b) => a.at - b.at);
}

/**
 * The mark a press or hover at `percent` is on, if any: a count under the pointer first, then the nearest line within
 * reach, then the shortest bar under it, so a short edit inside a long one can still be reached.
 */
export function editUnder(layout: readonly EditLayout[], percent: number, width: number) {
  if (!(width > 0)) return undefined;
  const x = percent / 100 * width;
  let line: EditLayout | undefined, near = Infinity, bar: EditLayout | undefined, shortest = Infinity;
  for (const mark of layout) {
    const a = mark.at / 100 * width, b = mark.to / 100 * width;
    if (mark.shape === "count") {
      if (Math.abs(x - a) <= mark.width / 2 + 2) return mark;
    } else if (mark.shape === "cut" || mark.shape === "tick") {
      const d = Math.abs(x - a);
      if (d <= LINE_REACH && d < near) { line = mark; near = d; }
    } else if (x >= a - 2 && x <= b + 2 && b - a < shortest) { bar = mark; shortest = b - a; }
  }
  return line ?? bar;
}

