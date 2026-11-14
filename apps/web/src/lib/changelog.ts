import source from "../../../../CHANGELOG.md?raw";

/** One day of the changelog: its heading as written ("November 14, 2026") and its lines, newest first. */
export interface ChangelogDay { date: string; changes: string[] }

/** The days of a CHANGELOG.md, newest first. A `## ` heading starts a day and each `- ` line under it is one change. */
export function parseChangelog(text: string): ChangelogDay[] {
  const days: ChangelogDay[] = [];
  for (const line of text.split(/\r?\n/)) {
    const date = /^##\s+(.+?)\s*$/.exec(line)?.[1];
    if (date) { days.push({ date, changes: [] }); continue; }
    const change = /^[-*]\s+(.+?)\s*$/.exec(line)?.[1];
    if (change) days.at(-1)?.changes.push(change);
  }
  return days.filter(day => day.changes.length);
}

/** What this build of Scarlet says changed, up to and including itself. */
export const CHANGELOG: ChangelogDay[] = parseChangelog(source);

/** The changes a newer build's changelog lists that this build's doesn't, newest first. */
export function changesSince(next: ChangelogDay[], current: ChangelogDay[] = CHANGELOG): string[] {
  const known = new Set(current.flatMap(day => day.changes));
  return next.flatMap(day => day.changes).filter(change => !known.has(change));
}

/** A changelog line with its `code` spans and **bold** marks dropped, for plain text. */
export function plainChange(change: string): string {
  return change.replace(/\*\*(.+?)\*\*|`(.+?)`/g, (_, bold, code) => bold ?? code);
}
