import { useState } from "react";
import { CHANGELOG, plainChange, type ChangelogDay } from "../../lib/changelog";
import { Icon } from "../ui/primitives";

/** How many changes from the latest day to show up front before folding the rest. */
const INITIAL_CHANGES = 5;

/** Show the latest changes up front without letting a busy day take over the page, and keep older days collapsible. */
export function Changelog({ days = CHANGELOG }: { days?: ChangelogDay[] }) {
  const [expanded, setExpanded] = useState(false);
  const [latest, ...earlier] = days;
  if (!latest) return null;

  // Don't hide a lone extra line behind a toggle; show all when at most one would fold.
  const canFold = latest.changes.length > INITIAL_CHANGES + 1;
  const visible = canFold && !expanded ? latest.changes.slice(0, INITIAL_CHANGES) : latest.changes;
  const hiddenCount = latest.changes.length - INITIAL_CHANGES;

  return <section className="card about-changelog" aria-labelledby="changelog-heading">
    <div className="about-changelog-head">
      <h2 id="changelog-heading">What’s new</h2>
      <span className="about-changelog-date">{latest.date}</span>
    </div>
    <ChangeList changes={visible} />
    {canFold && (
      <button
        type="button"
        className="about-changelog-more"
        aria-expanded={expanded}
        onClick={() => setExpanded(open => !open)}
      >
        {expanded ? "Show fewer" : `Show ${hiddenCount} more`}
      </button>
    )}
    {earlier.length > 0 && <details className="about-disclosure">
      <summary>Earlier changes<Icon name="chevron" size={12} /></summary>
      <div className="about-earlier-days">
        {earlier.map(day => <EarlierDay key={day.date} {...day} />)}
      </div>
    </details>}
  </section>;
}

function EarlierDay({ date, changes }: ChangelogDay) {
  return <details className="about-release-day">
    <summary>
      <span className="about-release-date">{date}</span>
      <span className="about-release-meta">
        <span>{changes.length}</span>
        <Icon name="chevron" size={11} />
      </span>
    </summary>
    <ChangeList changes={changes} />
  </details>;
}

function ChangeList({ changes }: { changes: string[] }) {
  return <ul className="about-change-list">
    {changes.map((change, index) => <li key={`${index}:${change}`}>{plainChange(change)}</li>)}
  </ul>;
}
