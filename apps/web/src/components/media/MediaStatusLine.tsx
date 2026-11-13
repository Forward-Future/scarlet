import type { ReactNode } from "react";
import { Icon } from "../ui/primitives";

/**
 * One job on a Media row, caching or transcribing, as one line: its state in a word or two and, while it runs, a bar
 * and a percent after them. `bar.fraction` is how far along the job is and `bar.percent` the same as it reads; leave
 * them out while that isn't known yet. A finished job stays on the row as a gray tick and its word (`done`), so a
 * line that showed progress doesn't just go.
 */
export function MediaStatusLine({ name, status, bar, children }: {
  name: string;
  status: { text: string; tone: "ok" | "busy" | "idle" | "bad" | "done" };
  bar?: { label: string; fraction?: number; percent?: string };
  children?: ReactNode;
}) {
  const said = bar?.percent ? `${status.text} · ${bar.percent}` : status.text;
  return <div className={`media-status${bar ? " has-bar" : ""}`}>
    <div className="media-cache-line">
      <span className={`media-cache is-${status.tone}`} role="status" aria-label={`${name}: ${said}`}
        title={status.tone === "bad" ? status.text : undefined}>
        {(status.tone === "ok" || status.tone === "done") && <Icon name="check" size={11} />}{status.text}
      </span>
      {children}
    </div>
    {bar && <progress className="activity-progress" aria-label={bar.label} value={bar.fraction} max={1} />}
    {bar && <span className="media-pct" aria-hidden="true">{bar.percent}</span>}
  </div>;
}
