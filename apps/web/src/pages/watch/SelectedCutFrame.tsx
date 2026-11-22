import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { timelineDuration, type Project, type Timeline } from "@scarlet/timeline";
import type { JoinClock } from "../../lib/joinClock";
import { player } from "../../lib/player";
import { CachedVideo } from "../../components/player/CachedVideo";
import { CutStream } from "../../components/player/CutStream";
import type { CutPlaybackWindow } from "../../components/review/usePrepareNextCut";

const noop = () => {};

export function SelectedCutFrame({ url, time, fps }: { url: string; time: number; fps: number }) {
  const [needed, setNeeded] = useState(false);
  useLayoutEffect(() => {
    const video = player.element();
    const target = player.elementTime(time);
    const decoded = () => !!video && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.5 / fps;
    if (decoded()) { setNeeded(false); return; }
    // A local file or buffered fragment often wins the race against a JPEG.
    // An unbuffered edit fragment must first render; request its exact still now.
    const buffered = video?.buffered;
    const missingFragment = video?.currentSrc.startsWith("blob:") && buffered &&
      !Array.from({ length: buffered.length }, (_, i) => i).some(i => buffered.start(i) <= target && target < buffered.end(i));
    const timer = video?.readyState && !missingFragment ? setTimeout(() => setNeeded(!decoded()), 120) : undefined;
    if (timer === undefined) setNeeded(true);
    const ready = () => {
      if (decoded()) { clearTimeout(timer); setNeeded(false); }
    };
    video?.addEventListener("seeked", ready);
    video?.addEventListener("loadeddata", ready);
    video?.addEventListener("canplay", ready);
    return () => {
      clearTimeout(timer);
      video?.removeEventListener("seeked", ready);
      video?.removeEventListener("loadeddata", ready);
      video?.removeEventListener("canplay", ready);
    };
  }, [url, time, fps]);
  return needed && <img src={url} alt="Selected edit frame" draggable={false}
    className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-0"
    onLoad={e => { e.currentTarget.style.opacity = "1"; }} />;
}

/** Mount the bounded file only before an audition starts or while its side is parked. Seeking
 * outside it hands the same version clock back to the full segmented player at the editor's point. */
export function CutSide({ project, timeline, url, window, parkedAt, active, fps, label, joins }: {
  project: Project; timeline: Timeline; url?: string; window?: CutPlaybackWindow; parkedAt?: number;
  active: boolean; fps: number; label: string; joins?: JoinClock;
}) {
  const [outside, setOutside] = useState(false);
  const handoff = useRef<{ time: number; resume: boolean }>(undefined);
  const displayed = useRef<{ active: boolean; url?: string; file?: CutPlaybackWindow }>(undefined);
  const isActive = parkedAt === undefined;
  const current = isActive && displayed.current?.active ? displayed.current : { url, file: url ? undefined : window };
  const { file } = current;
  const fileDuration = useMemo(() => file ? timelineDuration(timeline) : 0, [file, timeline]);
  useLayoutEffect(() => {
    displayed.current = { active: isActive, url: current.url, file };
    if (!isActive) setOutside(false);
  }, [isActive, current.url, file]);
  useLayoutEffect(() => {
    if (!outside || !isActive || !handoff.current) return;
    const { time, resume } = handoff.current;
    handoff.current = undefined;
    player.prepare();
    player.seek(time, true);
    if (resume) player.play();
  }, [outside, isActive, joins]);
  if (current.url || (file && !outside)) {
    const path = current.url ?? file!.url;
    return <CachedVideo key={path} url={path} label={label} fps={fps} active={active} hidden={false} autoPlay={false} joins={joins} parkedAt={parkedAt}
      windowed={file ? { file, duration: fileDuration, outOfRange(time, resume) {
        handoff.current = { time: joins ? joins.toView(time) : time, resume };
        setOutside(true);
      } } : undefined} />;
  }
  return <CutStream project={project} timeline={timeline} version={timeline.version} joins={joins}
    proposed={label === "Proposed draft"} onStart={noop} parkedAt={parkedAt} />;
}
