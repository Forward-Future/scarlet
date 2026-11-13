import { interactiveFrameUrl } from "../review/thumbs";
import { useLayoutEffect, useRef, useState } from "react";
import { api } from "../../lib/client";
import { player } from "../../lib/player";
import { openSourcePlayback } from "../../lib/sourcePlayback";
import { usePlayerStore } from "../../stores/player";
import { FramedVideo } from "./FramedVideo";

export function SourcePlayer({ id, name, duration, autoPlay, hidden }: {
  id: string; name: string; duration: number; autoPlay: boolean; hidden: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [poster] = useState(() => interactiveFrameUrl(api.frameUrl(id, usePlayerStore.getState().time, 960)));
  const [state, setState] = useState<"ready" | "loading" | "failed">("ready");
  useLayoutEffect(() => {
    const video = ref.current!;
    const saved = usePlayerStore.getState();
    const session = openSourcePlayback(video, { original: api.mediaFileUrl(id), chunkUrl: index => api.sourcePreviewUrl(id, index),
      duration, start: saved.time, rate: saved.rate, onState: setState });
    player.attach(video, session);
    return () => { player.detach(); session.dispose(); };
  }, [id, duration]);
  useLayoutEffect(() => { if (autoPlay) player.play(); }, [id, autoPlay]);
  return <div hidden={hidden} className="absolute inset-0 bg-black">
    {/* A section being prepared is marked on the video. The monitor's play button shows the wait, in place of its icon. */}
    <FramedVideo ref={ref} poster={poster} aria-label={name} playsInline preload={hidden ? "none" : "metadata"} data-waiting={state === "loading" || undefined}
      onClick={() => player.toggle()} />
    {state === "failed" && <div className="absolute inset-0 grid place-items-center">
      <button className="btn-ghost" onClick={() => player.play()}>Retry this section</button>
    </div>}
  </div>;
}
