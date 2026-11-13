import type { MediaAsset } from "@scarlet/timeline";
import { pct } from "../../lib/format";
import { isLink } from "../../lib/pendingImports";
import { useProjectStore } from "../../stores/project";
import { ActivityProgress } from "../ui/primitives";
import type { LocalImport, UploadItem } from "./UploadDropzone";

/**
 * The step of reading a file that Scarlet is on, and how far that step has got. Media's row and the card over the
 * player say both the same way. There is no guess at the time left, and a step still under way never says 100%.
 * `paused`: the pause holds a file's read until resume, so no step is under way and it says only that (`held`).
 */
export function preparationStep(file: MediaAsset, paused = false): { text: string; percent?: string; held?: true } {
  if (paused) return { text: "Reading paused", held: true };
  const progress = file.preparation;
  if (!progress) return { text: "Preparing footage" };
  return { text: { waveform: "Reading audio waveform", preview: "Creating video preview", fingerprint: "Checking file" }[progress.stage],
    percent: pct(Math.min(progress.fraction, 0.99)) };
}

export function preparationLabel(file: MediaAsset, paused = false) {
  const { text, percent, held } = preparationStep(file, paused);
  return held ? text : percent ? `${text} · ${percent}` : `${text}…`;
}

export function ImportProgress({ localImport, upload, preparing }: {
  localImport?: LocalImport | null; upload?: UploadItem; preparing?: MediaAsset;
}) {
  const paused = useProjectStore(s => !!s.current?.project.mediaPaused);
  const name = localImport?.name ?? upload?.name ?? preparing?.name;
  let step = "Starting import…";
  let value: number | undefined;
  // A read the pause holds has no bar: one that stood still would say it was under way.
  let held = false;
  if (localImport) {
    const checked = localImport.checked;
    // A link has no original on this computer to copy: the engine downloads it, and reports nothing until it has.
    if (checked === undefined) step = isLink(localImport.path) ? "Downloading…" : "Copying original into project…";
    else if (checked === 0) step = "Reading media details…";
    else if (checked < 1) {
      step = `Checking file · ${pct(checked)}`;
      value = checked;
    } else step = "Finishing import…";
  } else if (upload?.state === "uploading") {
    value = upload.progress;
    step = `Uploading · ${pct(value)}`;
  } else if (upload) step = "Reading media details…";
  else if (preparing) {
    step = preparationLabel(preparing, paused);
    value = preparing.preparation?.fraction;
    held = paused;
  }
  return <>
    <div className="flex items-baseline justify-between gap-3 text-[13px]">
      <span className="min-w-0 truncate font-medium" title={name}>{name ?? "Adding footage"}</span>
      {localImport && <span className="shrink-0 text-xs text-muted tnum">File {localImport.position} of {localImport.total}</span>}
    </div>
    {held ? <div role="status" className="mt-1.5 text-xs text-muted">{step}</div>
      : <ActivityProgress label={name ? `Import progress for ${name}` : "Import progress"} value={value}>{step}</ActivityProgress>}
  </>;
}
