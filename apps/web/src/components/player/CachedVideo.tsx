import { useLayoutEffect, useRef, useState } from "react";
import { player } from "../../lib/player";
import { usePlayerStore } from "../../stores/player";
import type { JoinClock } from "../../lib/joinClock";
import { parkVideo } from "./parkVideo";
import { FramedVideo } from "./FramedVideo";
import type { CutPlaybackWindow } from "../review/usePrepareNextCut";

/** The completed preview uses one seekable local file and the same timeline clock. */
export function CachedVideo({ url, label, hidden, active, autoPlay, joins, parkedAt, fps = 30, windowed }: { url: string; label: string; hidden: boolean; active: boolean; autoPlay: boolean; joins?: JoinClock; parkedAt?: number; fps?: number;
  windowed?: { file: CutPlaybackWindow; duration: number; outOfRange(time: number, playing: boolean): void } }) {
  const video = useRef<HTMLVideoElement>(null);
  const outside = useRef(windowed?.outOfRange);
  outside.current = windowed?.outOfRange;
  const leavingAt = useRef<number>(undefined);
  const start = windowed?.file.start ?? 0;
  const end = windowed?.file.end;
  const duration = windowed?.duration;
  const parkedFrame = useRef<number>(undefined);
  const wasActive = useRef(false);
  // Playback carries over from the player this one replaces, unless the editor pauses before the file opens.
  // A pause shows on that player's video at once, but the store only hears of it from the video's own event, a
  // moment later. Paused just as this player takes over, the store alone still says playing, and the file would
  // play by itself.
  const resume = useRef<boolean>(undefined);
  resume.current ??= autoPlay || (usePlayerStore.getState().playing && !player.element()?.paused);
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    const el = video.current!;
    if (parkedAt !== undefined) {
      parkedFrame.current = parkedAt;
      resume.current = false;
      const outgoing = wasActive.current;
      wasActive.current = false;
      return parkVideo(el, Math.max(0, parkedAt - start), fps, time => { el.currentTime = Math.min(time, el.duration); }, outgoing ? player.element : undefined);
    }
    player.attach(el, end === undefined ? undefined : {
      offset: start, duration, prepare() {},
      seek(time) {
        if (time >= start - 1e-6 && time <= end + 1e-6) return;
        leavingAt.current = time;
        outside.current?.(time, !el.paused);
        return true;
      },
    }, parkedFrame.current);
    wasActive.current = true;
    parkedFrame.current = undefined;
    return () => {
      // A listen or a completed scrub can call play immediately after an out-of-window seek.
      if (leavingAt.current !== undefined) outside.current?.(leavingAt.current, !el.paused);
      leavingAt.current = undefined;
      if (player.element() === el) player.detach();
      if (!el.paused) el.pause();
    };
  }, [parkedAt, fps, start, end, duration]);
  useLayoutEffect(() => player.setJoins(video.current, joins), [joins, parkedAt]);
  return <div hidden={hidden} className="absolute inset-0">
    <FramedVideo ref={video} src={url} aria-label={label} preload={parkedAt === undefined ? "metadata" : "auto"} playsInline
      onClick={() => player.toggle()} onError={() => setFailed(true)} onPause={() => { resume.current = false; }}
      onEnded={e => {
        if (parkedAt === undefined && end !== undefined && duration !== undefined && player.endOfWindow(e.currentTarget, end) && end < duration - 0.5 / fps)
          outside.current?.(end, true);
      }}
      onLoadedMetadata={e => {
        if (parkedAt !== undefined) return;
        const saved = usePlayerStore.getState();
        e.currentTarget.currentTime = Math.max(0, Math.min(player.mediaTime(saved.time) - start, e.currentTarget.duration));
        e.currentTarget.playbackRate = saved.rate;
        if (active && !hidden && resume.current) player.play();
        resume.current = false;
      }} />
    {failed && <button className="absolute inset-0 m-auto h-fit w-fit btn-ghost" onClick={() => { setFailed(false); video.current?.load(); }}>Retry cached video</button>}
  </div>;
}
