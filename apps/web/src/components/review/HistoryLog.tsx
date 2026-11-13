import { useEffect, useMemo, useState } from "react";
import type { ActivityEntry } from "@scarlet/shared";
import { errorMessage } from "../../lib/client";
import { relTime } from "../../lib/format";
import { useProjectStore } from "../../stores/project";
import { Avatar, Spinner } from "../ui/primitives";

const FILTERS: Array<{ id: string; label: string; match: (type: string) => boolean }> = [
  { id: "all", label: "Everything", match: () => true },
  { id: "decisions", label: "Decisions", match: (t) => t.startsWith("change.") || t.startsWith("version.") || t.startsWith("import.") },
  { id: "requests", label: "Edits and notes", match: (t) => t.startsWith("request.") || t.startsWith("question.") || t.startsWith("note.") },
  { id: "project", label: "Footage and settings", match: (t) => t.startsWith("media.") || t.startsWith("project.") || t.startsWith("members.") || t.startsWith("skill.") || t.startsWith("action.") },
];

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/** The entries that carry a small mark before their words: approved, put back or sent back, gone wrong. The words stay white. */
const MARK: Record<string, string> = {
  "change.approved": "bg-ok",
  "change.undone": "bg-warn",
  "change.sent_back": "bg-warn",
  "version.restored": "bg-warn",
  "project.deleted": "bg-bad",
  "media.failed": "bg-bad",
  "request.failed": "bg-bad",
};

/**
 * Everything that ever happened to this project, newest first. Entries are
 * permanent: an approval that was undone shows both the approval and the undo.
 */
export function HistoryLog() {
  const current = useProjectStore((s) => s.current);
  const loadActivity = useProjectStore((s) => s.loadActivity);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // A failed "Show older" has its own line, so the entries already loaded stay.
  const [olderError, setOlderError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const activity = current?.activity;

  useEffect(() => {
    if (activity) return;
    setError(null);
    loadActivity().catch((e) => setError(errorMessage(e)));
  }, [activity, loadActivity, attempt]);

  const shown = useMemo(() => (activity ?? []).filter((a) => FILTERS.find((f) => f.id === filter)!.match(a.type)), [activity, filter]);
  const days = useMemo(() => {
    const out: Array<{ day: string; entries: ActivityEntry[] }> = [];
    for (const a of shown) {
      const day = dayLabel(a.createdAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.entries.push(a);
      else out.push({ day, entries: [a] });
    }
    return out;
  }, [shown]);

  if (!current) return null;
  if (!activity) {
    if (error) {
      return (
        <p className="text-[13px] text-bad" role="alert">
          Couldn’t load the history: {error} <button className="btn-quiet" onClick={() => setAttempt((a) => a + 1)}>Retry</button>
        </p>
      );
    }
    return (
      <p className="text-[13px] text-muted flex items-center gap-2">
        <Spinner className="size-3" /> Loading history…
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter history">
        {FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)} className={`chip px-3 py-1 text-[12px] ${filter === f.id ? "bg-hi-dim text-fg" : "bg-raised text-muted hover:text-fg"}`}>
            {f.label}
          </button>
        ))}
      </div>

      {days.length === 0 && <p className="mt-6 text-[13px] text-muted">Nothing here yet.</p>}
      {days.map((d) => (
        <section key={d.day} className="mt-6">
          <h3 className="eyebrow mb-2">{d.day}</h3>
          <ol className="flex flex-col">
            {d.entries.map((a) => {
              return (
                <li key={a.id} className="flex items-start gap-3 py-2 border-b border-line/50 last:border-0">
                  {a.actor.type === "human" ? (
                    <Avatar name={a.actor.name} size={22} />
                  ) : (
                    <span className="size-[22px] shrink-0 rounded-full bg-raised grid place-items-center text-[9px] font-semibold text-muted">{a.actor.type === "agent" ? "AI" : "S"}</span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] leading-snug text-fg">
                      {MARK[a.type] && <span className={`history-mark ${MARK[a.type]}`} aria-hidden />}{a.summary}
                    </div>
                    <div className="mt-0.5 text-[11px] text-dim" title={new Date(a.createdAt).toLocaleString()}>
                      {relTime(a.createdAt)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}

      {!current.activityComplete && activity.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            className="btn-ghost"
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              setOlderError(null);
              loadActivity(true)
                .catch((e) => setOlderError(errorMessage(e)))
                .finally(() => setLoadingMore(false));
            }}
          >
            {loadingMore && <Spinner className="size-3" />} Show older
          </button>
          {olderError && <span className="text-[13px] text-bad" role="alert">Couldn’t load older history: {olderError}</span>}
        </div>
      )}
    </div>
  );
}
