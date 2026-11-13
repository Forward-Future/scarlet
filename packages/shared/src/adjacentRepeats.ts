/** Index possible second starts of an immediately repeated phrase in playback order.
 * Each caller can try the longest match first, then reject it for its own evidence
 * (for example an intervening pause, overlapping speakers or a protected word).
 */
export function adjacentRepeatCandidates(tokens: readonly string[], starts: readonly number[]): (at: number) => number[] {
  const nextSame = new Int32Array(tokens.length).fill(-1);
  const seen = new Map<string, number>();
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]!;
    nextSame[i] = seen.get(token) ?? -1;
    seen.set(token, i);
  }

  return at => {
    const lengths: number[] = [];
    for (let next = nextSame[at]!; next >= 0; next = nextSame[next]!) {
      const length = next - at;
      if (next + length > tokens.length) break;
      // Look for a pickup within the same 25 seconds as the source scan. Short
      // repeats that earlier releases detected still qualify at a slower pace.
      if (length > 5 && starts[next]! - starts[at]! > 25) break;
      let matched = 1;
      while (matched < length && tokens[at + matched] === tokens[next + matched]) matched++;
      if (matched === length) lengths.push(length);
    }
    return lengths.reverse();
  };
}
