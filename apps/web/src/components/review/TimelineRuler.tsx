import { memo } from "react";
import { clock } from "../../lib/format";

const intervals = [.1, .25, .5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export const TimelineRuler = memo(function TimelineRuler({ start, duration, width }: {
  start: number; duration: number; width: number;
}) {
  if (duration <= 0 || width <= 0) return null;
  // Leave about a thumb's width per label, regardless of the length of the edit.
  const spacing = duration / Math.max(1, Math.floor(width / 90));
  const step = intervals.find(value => value >= spacing) ?? Math.ceil(spacing / 3600) * 3600;
  // Each time label has its tick and nothing between them: the ruler only says where in the video the timeline is.
  const ticks = [];
  for (let i = Math.ceil(start / step - 1e-7); i * step < start + duration; i++) {
    const time = i * step;
    const offset = (time - start) / duration;
    // As the player, the cards and the chat write a time: "0:02", not "00:02".
    const stamp = clock(time);
    const fraction = step < 1 ? (time % 1).toFixed(2).slice(1) : "";
    ticks.push(<span key={i} className="ruler-major" style={{ left: `${offset * 100}%` }}>
      {(1 - offset) * width >= 76 && <span>{stamp}{fraction}</span>}
    </span>);
  }
  return <div className="timeline-ruler" aria-hidden="true">{ticks}</div>;
});
