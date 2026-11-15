/**
 * A thin line under a header button's word: filled as far as the work has got, or a short stretch that slides along
 * while the work is unmeasured. The button positions it, so it spans the word and not the padding.
 */
export function ProgressLine({ progress }: { progress?: number }) {
  return <span className={`progress-line${progress == null ? " is-unknown" : ""}`} aria-hidden="true">
    <span style={progress != null ? { width: `${Math.max(2, Math.min(100, progress * 100))}%` } : undefined} />
  </span>;
}
