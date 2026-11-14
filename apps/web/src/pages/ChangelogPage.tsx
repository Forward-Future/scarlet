import { useEffect, useMemo, useRef, useState } from "react";
import { buildThreads, changeEdits, matchesEdit, threadEditList, type EditRef, type VersionSummary } from "@scarlet/shared";
import { historyLineage, type Change } from "@scarlet/timeline";
import { errorMessage } from "../lib/client";
import { authorLabel, clock, relTime, removedSeconds } from "../lib/format";
import { useProjectStore } from "../stores/project";
import { HistoryLog } from "../components/review/HistoryLog";
import { editGroups } from "../components/review/ThreadEdits";

type ListedEdit = ReturnType<typeof changeEdits>[number];
type EditGroup = ReturnType<typeof editGroups<ListedEdit>>[number];

/**
 * The edits one version made, as its row lists them, counted as the chat counts them: an edit made in several places
 * is one. Nothing when the row already says it all: a single edit nobody revised, an undo, an empty timeline.
 */
function versionEdits(change: Change | undefined, thread: ListedEdit[]): EditGroup[] | undefined {
  // An undo is saved with a range for each place it put back. Counted as edits, undoing a pass read "1 edit … 3 places".
  if (change?.revertsVersion) return undefined;
  const own = change?.state === "approved" ? changeEdits(change) : [];
  const revised = own.some(edit => thread.some(t => t.previous.length && (t.changeId === edit.changeId || matchesEdit(t, edit))));
  return own.length > 1 || revised ? editGroups(own) : undefined;
}

/**
 * Every edit one version made, such as each cut of a dialogue pass, with how much it took out and its revisions:
 * the edit it replaced, and whether a later revision replaced it.
 */
function VersionEdits({ groups, thread }: { groups: EditGroup[]; thread: ListedEdit[] }) {
  const changes = useProjectStore(s => s.current?.changes);
  // An edit is found by its place in its change. The list is in time order, so that place is not its position in it.
  const labelOf = (ref: EditRef) => {
    const earlier = changes?.find(c => c.id === ref.changeId);
    return earlier && changeEdits(earlier).find(edit => edit.spot === ref.spot)?.label;
  };
  return <div className="version-edits" role="group" aria-label="Edits in this version">
    <div className="version-edits-head">{groups.length} {groups.length === 1 ? "edit" : "edits"}</div>
    <ol>
      {groups.map(({ members }) => {
        const { edit } = members[0]!;
        // A revision names the edit it replaced. An edit a later revision replaced says so. An edit made in several
        // places says it for the first place that was.
        const revisions = members.map(({ edit: place }) => {
          const latest = thread.find(t => matchesEdit(t, place));
          const stands = latest?.changeId === place.changeId && latest.spot === place.spot;
          return { revises: stands ? latest.previous.at(-1) : undefined, revisedLater: latest && !stands ? latest : undefined };
        });
        const revises = revisions.find(r => r.revises)?.revises;
        const revisedLater = revisions.find(r => r.revisedLater)?.revisedLater;
        const removed = edit.beforeCut?.removed;
        // A cut says how much came out; an edit made in several places says how many.
        const value = members.length > 1 ? `${members.length} places` : removed && removedSeconds(removed.end - removed.start);
        return <li key={edit.spot}>
          <span className="version-edit-time">{clock(removed?.start ?? edit.range.start)}</span>
          <span className="version-edit-label">{edit.label}
            {revises && <small>Revises “{labelOf(revises) ?? "an earlier edit"}”</small>}
            {revisedLater && <small>Revised later: “{revisedLater.label}”</small>}
          </span>
          {value && <span className="version-edit-value">{value}</span>}
        </li>;
      })}
    </ol>
  </div>;
}

/**
 * The story of the cut: every applied version on this branch, newest first, in plain words.
 * History is for looking. Undoing and revising happen in the edit's thread.
 */
export function ChangelogPage() {
  const current = useProjectStore((s) => s.current);
  const [tab, setTab] = useState<"cut" | "history">(() => (location.hash === "#history" ? "history" : "cut"));
  const [open, setOpen] = useState<string | null>(null);
  // An applied edit moves the head before its list of versions arrives, and the list is unset while the new one loads.
  // The last list that held its head stays on screen until then, so History neither goes blank nor reloads.
  const held = useRef<{ project: string; versions: VersionSummary[]; head: string | null }>(undefined);
  const loaded = current?.versions;
  if (current && loaded && (!current.project.head || !loaded.length || loaded.some(v => v.version === current.project.head))) {
    held.current = { project: current.id, versions: loaded, head: current.project.head };
  }
  const list = held.current?.project === current?.id ? held.current : undefined;
  const versions = useMemo(() => [...(list?.versions ?? [])].sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "")), [list?.versions]);
  const [historyError, setHistoryError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (tab !== "cut" || current?.versions || !current) return;
    let active = true;
    setHistoryError("");
    void useProjectStore.getState().loadVersions().catch(error => { if (active) setHistoryError(errorMessage(error)); });
    return () => { active = false; };
  }, [tab, current?.id, current?.project.head, current?.historyRevision, current?.versions, attempt]);
  const changeById = useMemo(() => new Map(current?.changes.map(c => [c.id, c])), [current?.changes]);
  const { lineage, undone } = useMemo(() => historyLineage(versions, list?.head ?? null), [versions, list?.head]);
  // Each applied change's thread as a list of edits, which says what a revision replaced.
  const threadEdits = useMemo(() => {
    const lists = new Map<string, ListedEdit[]>();
    if (!current) return lists;
    for (const thread of buildThreads({ changes: current.changes, tasks: current.tasks, notes: current.notes })) {
      const edits = threadEditList(thread);
      for (const change of thread.changes) if (!lists.has(change.id)) lists.set(change.id, edits);
    }
    return lists;
  }, [current?.changes, current?.tasks, current?.notes]); // eslint-disable-line react-hooks/exhaustive-deps
  // What each version on this branch opens into, worked out before it is opened: a row with nothing to list isn't a button.
  const rows = useMemo(() => versions.filter(v => lineage.has(v.version)).map(version => {
    const change = version.changeId ? changeById.get(version.changeId) : undefined;
    const thread = (change && threadEdits.get(change.id)) ?? [];
    return { version, thread, groups: versionEdits(change, thread) };
  }), [versions, lineage, changeById, threadEdits]);
  if (!current) return null;

  return (
    <div className="flex-1 overflow-y-auto">
      <div>
        <nav className="control-tabs" aria-label="Changelog view">
          {(["cut", "history"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} aria-current={tab === t} className={`rounded-md px-3 py-1.5 text-[13px] ${tab === t ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}>
              {t === "cut" ? "Edit versions" : "Full history"}
            </button>
          ))}
        </nav>

        {tab === "history" && (
          <div className="mt-5">
            <HistoryLog />
          </div>
        )}

        {tab === "cut" && (
        <section className="mt-5">
        <ol className="relative border-l border-line ml-2">
          {rows.map(({ version: v, thread, groups }) => {
            const isHead = v.version === list?.head;
            const expanded = open === v.version;
            const summary = <>
              <div className="flex items-baseline gap-2">
                <span className={`text-[14px] font-medium${groups ? " group-hover:underline decoration-line underline-offset-4" : ""}`}>{v.description ?? "Untitled edit"}</span>
                {undone.has(v.version) && <span className="chip">Undone</span>}
                {isHead && <span className="chip bg-hi-dim text-fg">Current</span>}
              </div>
              <div className="mt-0.5 text-[12px] text-muted">
                {v.author ? authorLabel(v.author) : "Unknown"} · {relTime(v.createdAt)} · {clock(v.duration)} long
              </div>
            </>;
            return (
              <li key={v.version} data-version={v.version} className="relative pl-6 pb-5">
                <span className={`absolute -left-[5px] top-5 size-2.5 rounded-full ring-4 ring-bg ${isHead ? "bg-fg" : "bg-dim"}`} />
                {/* A version with edits to list opens into them. Any other is the whole story as it stands: the same box, with nothing to press. */}
                {groups
                  ? <button className="version-row w-full text-left group" onClick={() => setOpen(expanded ? null : v.version)} aria-expanded={expanded}>{summary}</button>
                  : <div className="rounded-lg border border-line bg-panel px-3 py-2.5">{summary}</div>}
                {expanded && groups && <div className="mt-3"><VersionEdits groups={groups} thread={thread} /></div>}
              </li>
            );
          })}
          {/* Once a list is up, a newer one loads behind it. Only a failure to load says so. */}
          {!current.versions && (historyError
            ? <li role="status">{historyError} <button className="btn-ghost" onClick={() => setAttempt(a => a + 1)}>Retry</button></li>
            : !list && <li role="status">Loading versions…</li>)}
          {list?.versions.length === 0 && <li className="pl-6 text-[13px] text-muted">Applied edits appear here.</li>}
        </ol></section>
        )}
      </div>
    </div>
  );
}
