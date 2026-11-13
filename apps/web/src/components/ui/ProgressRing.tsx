/** A measured arc when progress is available, or a turning quarter while work is unmeasured. */
export function ProgressRing({ progress, className }: { progress?: number; className: string }) {
  const percent = progress == null ? 25 : Math.max(2, Math.min(100, progress * 100));
  return <svg className={`progress-ring ${className}${progress == null ? " is-unknown" : ""}`} viewBox="0 0 26 26" aria-hidden="true">
    <circle cx="13" cy="13" r="11.5" />
    <circle cx="13" cy="13" r="11.5" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - percent} />
  </svg>;
}
