import { requestText, type EditRef, type Task, type ThreadEdit } from "@scarlet/shared";
import { runEnded } from "../../components/review/RunBundle";
import { editRowWord } from "../../lib/editKind";
import { clock as clockLabel } from "../../lib/format";
import { runIsActive } from "../../lib/taskRun";
import type { Thread } from "../../lib/threads";
import { isWorking } from "./types";

/** One version of an edit: who asked for it, in what words, and where that version stands. */
interface Version { key: string; said: string; quoted: boolean; state?: string; now?: boolean; busy?: boolean }

const quote = (words: string) => `“${words.trim()}”`;
const about = (task: Task, ref: EditRef) => task.context.changeId === ref.changeId && (task.context.editIndex === ref.spot || task.context.cutIndex === ref.spot);

/**
 * The page of the cut or edit that's open, in the chat's place (the editor chose it on 2026-11-23): what it is, the
 * request it came from, and each of its versions with the editor's note that made it. A note about one cut or edit is
 * read here and not in the conversation. Scarlet's note on it stays on its card, once. The message box under the page
 * is aimed at it, so what is typed there is its next version.
 */
export function EditPage({ thread, edit, call, standing, nextQueuedId }: {
  thread: Thread;
  /** The applied edit that's open, */
  edit?: ThreadEdit;
  /** or the call of the pass that waits: its number, Scarlet's words for it, how much it takes out and the notes that sent it back. */
  call?: { n: number; summary: string; tag: string; at?: number; notes: readonly string[]; run?: Task };
  /** Where what's open stands now: Waits on you, Kept, Rejected. */
  standing: string;
  nextQueuedId?: string;
}) {
  const versions: Version[] = [];
  const waiting = (task: Task) => isWorking(task.state) ? "Revising…" : task.state === "waiting_for_user" ? "Needs your answer" : task.id === nextQueuedId ? "Up next" : "Queued";
  if (edit) {
    const refs: EditRef[] = [...edit.previous, { changeId: edit.changeId, spot: edit.spot }];
    refs.forEach((ref, i) => {
      const change = thread.changes.find(c => c.id === ref.changeId);
      const task = change?.taskId ? thread.tasks.find(t => t.id === change.taskId) : undefined;
      // The version a note asked for says the note; the first is Scarlet's own.
      const note = task && i > 0 && task.context.changeId ? requestText(task) : undefined;
      versions.push({ key: `${ref.changeId}/${ref.spot}`, said: note ? quote(note) : i === 0 ? (edit.marker ? "Marked by Scarlet" : "Made by Scarlet") : "Revised by Scarlet", quoted: !!note,
        state: i < refs.length - 1 ? "Sent back" : undefined });
    });
    // What is asked of it and hasn't landed: Scarlet is on it, or it waits its turn. One that stopped early says so.
    for (const task of thread.tasks) {
      if (!refs.some(ref => about(task, ref)) || thread.changes.some(c => c.taskId === task.id && c.state !== "failed")) continue;
      const ended = runEnded(task);
      if (runIsActive(task)) versions.push({ key: task.id, said: quote(requestText(task)), quoted: true, state: waiting(task), busy: isWorking(task.state) });
      else if (ended && task.state !== "done") versions.push({ key: task.id, said: quote(requestText(task)), quoted: true, state: ended });
    }
  } else if (call) {
    call.notes.forEach((note, i) => versions.push({ key: `note/${i}`, said: i === 0 ? "Made by Scarlet" : quote(call.notes[i - 1]!), quoted: i > 0, state: "Sent back" }));
    versions.push({ key: "now", said: call.notes.length ? quote(call.notes.at(-1)!) : "Made by Scarlet", quoted: call.notes.length > 0 });
    if (call.run && runIsActive(call.run)) versions.push({ key: call.run.id, said: quote(requestText(call.run)), quoted: true, state: waiting(call.run), busy: isWorking(call.run.state) });
  }
  // The last version that has landed is the one that stands: it waits on the editor, or says how they decided.
  const landed = versions.findLast(v => !v.state);
  if (landed) { landed.state = standing; landed.now = standing === "Waits on you"; }
  const title = edit ? edit.summary ?? edit.label : call?.summary ?? "";
  const kind = edit ? `${editRowWord(edit)} · ${clockLabel(edit.at ?? edit.range.start)}` : call ? `Cut ${call.n}${call.at !== undefined ? ` · ${clockLabel(call.at)}` : ""} · ${call.tag}` : "";
  return <article className="edit-page" aria-label={edit ? "Edit" : "Cut"}>
    <header className="edit-page-head">
      <p className="edit-page-from" title={thread.title}>From “{thread.title.split("\n")[0]}”</p>
      <h2 className="edit-page-title">{title}</h2>
      <p className="edit-page-kind">{kind}</p>
    </header>
    <section aria-label="Versions">
      <h3>Versions</h3>
      <ol className="edit-page-versions">
        {versions.map((v, i) => <li key={v.key} className={v.now ? "is-now" : undefined}>
          <span className="edit-page-v">v{i + 1}</span>
          <span className={v.quoted ? "edit-page-said is-yours" : "edit-page-said"}>{v.said}</span>
          {v.state && <span className={v.busy ? "edit-page-state working-text" : "edit-page-state"}>{v.state}</span>}
        </li>)}
      </ol>
    </section>
  </article>;
}
