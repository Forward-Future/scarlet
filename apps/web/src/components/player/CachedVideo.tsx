import { useLayoutEffect, useRef, useState } from "react";
import { player } from "../../lib/player";
import { usePlayerStore } from "../../stores/player";
import type { JoinClock } from "../../lib/joinClock";
import { FramedVideo } from "./FramedVideo";

/** The completed preview uses one seekable local file and the same timeline clock. */
export function CachedVideo({ url, label, hidden, active, autoPlay, joins }: { url: string; label: string; hidden: boolean; active: boolean; autoPlay: boolean; joins?: JoinClock }) {
  const video = useRef<HTMLVideoElement>(null);
  // Playback carries over from the player this one replaces, unless the editor pauses before the file opens.
  // A pause shows on that player's video at once, but the store only hears of it from the video's own event, a
  // moment later. Paused just as this player takes over, the store alone still says playing, and the file would
  // play by itself.
  const resume = useRef<boolean>(undefined);
  resume.current ??= autoPlay || (usePlayerStore.getState().playing && !player.element()?.paused);
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    player.attach(video.current);
    return () => player.detach();
  }, []);
  useLayoutEffect(() => player.setJoins(video.current, joins), [joins]);
  return <div hidden={hidden} className="absolute inset-0">
    <FramedVideo ref={video} src={url} aria-label={label} preload="metadata" playsInline
      onClick={() => player.toggle()} onError={() => setFailed(true)} onPause={() => { resume.current = false; }} onLoadedMetadata={e => {
        const saved = usePlayerStore.getState();
        e.currentTarget.currentTime = Math.min(player.mediaTime(saved.time), e.currentTarget.duration);
        e.currentTarget.playbackRate = saved.rate;
        if (active && !hidden && resume.current) player.play();
        resume.current = false;
      }} />
    {failed && <button className="absolute inset-0 m-auto h-fit w-fit btn-ghost" onClick={() => { setFailed(false); video.current?.load(); }}>Retry cached video</button>}
  </div>;
}
