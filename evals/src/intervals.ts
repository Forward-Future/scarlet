/** Half-open interval arithmetic on seconds. All functions return new, sorted, merged arrays. */
export interface Range { start: number; end: number }

const EPS = 1e-6;

export function merge(ranges: readonly Range[], gap = EPS): Range[] {
  const sorted = ranges.filter(r => r.end > r.start).map(r => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/** a minus b. */
export function subtract(a: readonly Range[], b: readonly Range[]): Range[] {
  const cut = merge(b);
  const out: Range[] = [];
  for (const r of merge(a)) {
    let start = r.start;
    for (const c of cut) {
      if (c.end <= start) continue;
      if (c.start >= r.end) break;
      if (c.start > start) out.push({ start, end: c.start });
      start = Math.max(start, c.end);
      if (start >= r.end) break;
    }
    if (r.end - start > EPS) out.push({ start, end: r.end });
  }
  return out.filter(r => r.end - r.start > EPS);
}

export function intersect(a: readonly Range[], b: readonly Range[]): Range[] {
  const x = merge(a), y = merge(b);
  const out: Range[] = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    const start = Math.max(x[i]!.start, y[j]!.start), end = Math.min(x[i]!.end, y[j]!.end);
    if (end - start > EPS) out.push({ start, end });
    if (x[i]!.end < y[j]!.end) i++; else j++;
  }
  return out;
}

export function total(ranges: readonly Range[]): number {
  return ranges.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0);
}

export function overlap(a: Range, b: Range): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** Seconds of `r` covered by the merged set. */
export function covered(r: Range, set: readonly Range[]): number {
  return set.reduce((sum, s) => sum + overlap(r, s), 0);
}

export function median(values: readonly number[]): number | undefined {
  return quantile(values, 0.5);
}

export function quantile(values: readonly number[], q: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
