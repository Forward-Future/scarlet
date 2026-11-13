// Return the first index that satisfies a monotone predicate, or the array length.
export function firstIndex(times: number[], matches: (time: number) => boolean): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (matches(times[mid]!)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Index closed time intervals for repeated overlap queries. Results retain their original order. */
export function intervalCandidates<T>(items: readonly T[], start: (item: T) => number, end: (item: T) => number) {
  const starts = items.map(start);
  const ends = items.map(end);
  if (items.some((_, i) => i > 0 && (starts[i]! < starts[i - 1]! || ends[i]! < ends[i - 1]!))) {
    // Search by start time, then restore stacking priority among just the hits.
    const byStart = items.map((item, i) => ({ item, i, start: starts[i]!, end: ends[i]! }))
      .sort((a, b) => a.start - b.start);
    let furthest = -Infinity;
    const maxEnds = byStart.map(entry => furthest = Math.max(furthest, entry.end));
    return (time: number, latestStart = time) => {
      const hits = [];
      for (let i = firstIndex(maxEnds, end => end >= time); i < byStart.length; i++) {
        const entry = byStart[i]!;
        if (entry.start > latestStart) break;
        if (entry.end >= time) hits.push(entry);
      }
      return hits.sort((a, b) => a.i - b.i).map(entry => entry.item);
    };
  }
  return (time: number, latestStart = time) => {
    const first = firstIndex(ends, end => end >= time);
    let last = first;
    while (last < items.length && starts[last]! <= latestStart) last++;
    return items.slice(first, last);
  };
}
