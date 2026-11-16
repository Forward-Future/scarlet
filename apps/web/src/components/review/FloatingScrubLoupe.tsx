import { useState, type CSSProperties } from "react";
import { playbackClock } from "../../lib/format";
import { LoupePicture, type LoupeSheet } from "./TimelineRange";

export interface ScrubLens { frame: number; at: number }

/** Keep the selected frame large and fixed. The frames on either side slide underneath it. */
export function FloatingScrubLoupe({ lens, first, last, fps, frameAt, sheet, pictureAspect }: {
  lens: ScrubLens; first: number; last: number; fps: number; pictureAspect: number;
  frameAt(time: number, exact?: boolean): string | undefined; sheet?: LoupeSheet;
}) {
  const { frame, at } = lens;
  const [origin] = useState(frame);
  // Cap portrait height while retaining the source aspect inside each cell.
  const cell = Math.min(77, 64 * pictureAspect);
  const cells = [];
  for (let f = Math.max(first, frame - 4); f <= Math.min(last, frame + 4); f++) {
    cells.push(<span className="scrub-loupe-cell" key={f} style={{ left: (f - origin) * cell }}>
      <LoupePicture frame={f} last={last} fps={fps} frameAt={frameAt} sheet={sheet} />
    </span>);
  }
  return <div className="scrub-loupe" data-frame={frame} aria-hidden="true" style={{
    "--lens-width": `${Math.min(420, 5.5 * cell)}px`, "--lens-cell": `${cell}px`,
    "--lens-aspect": pictureAspect, "--lens-at": `${at}%`,
    "--lens-hero": `${Math.min(148, 112 * pictureAspect)}px`,
  } as CSSProperties}>
    <div className="scrub-loupe-rail"><div className="scrub-loupe-film"
      style={{ transform: `translateX(${(origin - frame - .5) * cell}px)` }}>{cells}</div></div>
    <div className="scrub-loupe-hero">
      <span className="scrub-loupe-picture"><LoupePicture foreground frame={frame} last={last} fps={fps} frameAt={frameAt} sheet={sheet} /></span>
      <span className="scrub-loupe-time">{playbackClock(frame / fps)}</span>
    </div>
  </div>;
}
