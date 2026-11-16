/**
 * How a transition draws: the fades, blur and moves of each clip across its join, on the output clock. Where each
 * transition plays is planned in @scarlet/timeline (planTransitions), on the timeline as edited, inside the graph and
 * inside each section's cache key, so a transition only re-renders the sections around its join.
 */
import { planTransitions, type TransitionMotion } from "@scarlet/timeline";

export { planTransitions };
export type { TransitionMotion };

/** The motions that touch a span of output, in that span's own clock (0 at `from`). */
export function motionsIn(motions: readonly TransitionMotion[] | undefined, from: number, to: number) {
  return (motions ?? []).filter(m => m.end > from && m.start < to).map(m => ({ ...m, start: m.start - from, end: m.end - from }));
}

const n = (x: number) => String(Math.round(x * 1e6) / 1e6);

/** How far through the motion the picture is at output time `t`, eased: 0 before it, 1 after. */
function eased(m: TransitionMotion) {
  const p = `clip((t-${n(m.start)})/${n(Math.max(1e-6, m.end - m.start))},0,1)`;
  // A whip spends its time in the middle, where the blur hides the jump; the rest ease in and out.
  return m.type === "whip" ? `(${p}*${p}*${p}*(${p}*(6*${p}-15)+10))` : `(${p}*${p}*(3-2*${p}))`;
}

/** Filters on the layer's picture, once it is on the output clock. `ffColor` turns a colour into FFmpeg's. */
export function motionFilters(motions: readonly TransitionMotion[], width: number, ffColor: (color: string) => string): string[] {
  const out: string[] = [];
  // A fade can't start before the stream's clock does, as one begun before the section starts would. Run it on a
  // clock moved on by that much, then move the clock back.
  const fade = (m: TransitionMotion, options: string) => {
    const early = Math.max(0, -m.start);
    const f = `fade=${options}:st=${n(m.start + early)}:d=${n(Math.max(1e-6, m.end - m.start))}`;
    return early ? [`setpts=PTS+${n(early)}/TB`, f, `setpts=PTS-${n(early)}/TB`] : [f];
  };
  for (const m of motions) {
    const d = Math.max(1e-6, m.end - m.start);
    if (m.type === "dissolve" && m.role === "in") out.push(...fade(m, "t=in:alpha=1"));
    if (m.type === "dip") out.push(...fade(m, `t=${m.role === "out" ? "out" : "in"}:color=${ffColor(m.color)}`));
    if (m.type === "whip") {
      // A sideways blur through the middle of the move, as a fast pan smears.
      const vertical = m.direction === "up" || m.direction === "down";
      const size = Math.max(2, Math.round(width / 40));
      out.push(`avgblur=sizeX=${vertical ? 1 : size}:sizeY=${vertical ? size : 1}:enable='between(t,${n(m.start + d * 0.15)},${n(m.end - d * 0.15)})'`);
    }
  }
  return out;
}

/** What to add to the layer's overlay position for its moves, as expressions of the output time `t`. */
export function motionOffsets(motions: readonly TransitionMotion[], width: number, height: number): { x: string; y: string } {
  const xs: string[] = [], ys: string[] = [];
  for (const m of motions) {
    if (m.type !== "push" && m.type !== "whip" && m.type !== "slide") continue;
    // A slide moves only the picture arriving; the one leaving stays put under it.
    if (m.type === "slide" && m.role === "out") continue;
    const e = eased(m);
    // "left" carries the picture to the left: the leaving one goes off to the left, the arriving one comes in from the right.
    const travel = m.role === "out" ? `(-${e})` : `(1-${e})`;
    const sign = m.direction === "left" || m.direction === "up" ? 1 : -1;
    const size = m.direction === "left" || m.direction === "right" ? width : height;
    (m.direction === "left" || m.direction === "right" ? xs : ys).push(`${sign * size}*${travel}`);
  }
  return { x: xs.join("+"), y: ys.join("+") };
}
