import { CHANGELOG, plainChange } from "../../lib/changelog";

const RECENT_DAYS = 2;

/** What changed in Scarlet, newest first, as CHANGELOG.md says it up to this build. Older days fold away. */
export function Changelog() {
  const recent = CHANGELOG.slice(0, RECENT_DAYS);
  const earlier = CHANGELOG.slice(RECENT_DAYS);
  return <section className="changelog mt-6 max-w-prose space-y-3 text-sm leading-relaxed" aria-labelledby="changelog-heading">
    <h2 id="changelog-heading" className="font-semibold text-fg">What’s new</h2>
    {recent.map(day => <Day key={day.date} {...day} />)}
    {earlier.length > 0 && <details>
      <summary className="cursor-pointer text-muted">Earlier changes</summary>
      <div className="mt-3 space-y-3">{earlier.map(day => <Day key={day.date} {...day} />)}</div>
    </details>}
  </section>;
}

function Day({ date, changes }: { date: string; changes: string[] }) {
  return <div>
    <h3 className="text-[12px] text-dim">{date}</h3>
    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">{changes.map(change => <li key={change}>{plainChange(change)}</li>)}</ul>
  </div>;
}
