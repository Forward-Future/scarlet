import type { PictureMarks, TaskAttachment } from "@scarlet/shared";
import { api } from "../../lib/client";
import { clock, playbackClock } from "../../lib/format";
import { markedFramePicture } from "../../lib/markedFrame";
import { rememberMarkedFrame } from "../../lib/markedFramePictures";
import type { PendingAttachment } from "../../stores/attachments";
import type { MarkedFrame } from "../../stores/pictureMarks";
import { usePlayerStore } from "../../stores/player";
import { MarksDrawing } from "../player/PictureMarks";
import { Icon } from "../ui/primitives";

/** Where the playhead is, to the millisecond as the timeline's playhead reads. */
export function PlayheadClock() {
  const ms = usePlayerStore(s => Math.max(0, Math.round(s.time * 1000)));
  return <span className="composer-playhead">Playhead {playbackClock(ms / 1000)}</span>;
}

export const NO_FILES: PendingAttachment[] = [];

/**
 * The files the next message carries, as a line attached to the top of the box, one row each, as the queue's rows
 * read: a file mark, the name, and × to take it off. A file still on its way into the project is dim and says so; one
 * that couldn't be added says why.
 */
export function AttachedFiles({ files, onRemove, marked, onOpenMarked, onRemoveMarked }: { files: readonly PendingAttachment[]; onRemove(key: string): void;
  marked?: MarkedFrame; onOpenMarked(frame: MarkedFrame): void; onRemoveMarked(): void }) {
  const markedName = marked && `Marked frame ${clock(marked.time)}`;
  return <div className="composer-files" role="group" aria-label="Files attached to your message">
    {/* The frame the editor drew on: its picture with the marks, a press on it goes back there to mark more. */}
    {marked && <div className="composer-file is-marked-frame" title={`${markedName} · ${marked.marks.length === 1 ? "1 mark" : `${marked.marks.length} marks`}`}>
      <button type="button" className="composer-marked-frame" onClick={() => onOpenMarked(marked)} aria-label={`${markedName}, mark it again`}>
        <span className="composer-marked-picture" aria-hidden="true">
          {marked.picture && <img src={marked.picture} alt="" />}
          <MarksDrawing marks={marked.marks} />
        </span>
        <span className="composer-file-name">{markedName}</span>
        {marked.marks.length > 1 && <span className="composer-file-state">{marked.marks.length} marks</span>}
      </button>
      <button type="button" className="composer-file-remove" aria-label={`Remove ${markedName}`} title="Remove" onClick={onRemoveMarked}><Icon name="x" size={11} /></button>
    </div>}
    {files.map(file => <div key={file.key} className={`composer-file is-${file.state}`} title={file.error ? `${file.name}: ${file.error}` : file.name}>
      <span className="composer-file-icon"><Icon name="file" size={12} /></span>
      <span className="composer-file-name">{file.name}</span>
      {file.state === "adding" && <span className="composer-file-state" role="status">Adding…</span>}
      {file.state === "failed" && <span className="composer-file-state is-bad" role="alert">{file.error ?? "Couldn’t add it"}</span>}
      <button type="button" className="composer-file-remove" aria-label={`Remove ${file.name}`} title="Remove" onClick={() => onRemove(file.key)}><Icon name="x" size={11} /></button>
    </div>)}
  </div>;
}

/**
 * The marked frame on its way out with a message: its picture with the marks on it saved as one of the message's files,
 * and the marks themselves, so the model has both what the editor drew and where. A frame the engine can't give
 * stops the message, which says why and stays in the box.
 */
export async function sendMarks(projectId: string, frame: MarkedFrame): Promise<{ attachment: TaskAttachment; marks: PictureMarks }> {
  const where = { time: frame.time, ...(frame.version && { version: frame.version }), ...(frame.mediaId && { mediaId: frame.mediaId }), marks: frame.marks };
  if (!frame.picture) throw new Error("The marked frame has no picture to send. Mark it again.");
  const picture = await markedFramePicture(frame.picture, frame.marks);
  const { attachment } = await api.uploadAttachment(projectId, new File([picture], `Marked frame ${clock(frame.time).replace(/:/g, ".")}.png`, { type: "image/png" }));
  rememberMarkedFrame(attachment.id, picture);
  return { attachment, marks: { attachmentId: attachment.id, ...where } };
}
