import { useState, type ComponentPropsWithRef, type CSSProperties } from "react";

/** Keep the whole playback surface clickable while fitting the hover target to the picture. */
export function FramedVideo({ onClick, ...props }: Omit<ComponentPropsWithRef<"video">, "onClick"> & { onClick(): void }) {
  const [decodedAspect, setDecodedAspect] = useState<number>();
  const readSize = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const { videoWidth, videoHeight } = event.currentTarget;
    setDecodedAspect(videoWidth && videoHeight ? videoWidth / videoHeight : undefined);
  };
  return <div className="video-surface" onClick={onClick}>
    <div className="video-frame" data-picture={!!decodedAspect || !!props.poster || undefined}
      style={decodedAspect ? { "--picture-aspect": decodedAspect } as CSSProperties : undefined}>
      <video {...props} className="block h-full w-full object-contain"
        onResize={readSize} onLoadedMetadataCapture={readSize} onEmptied={() => setDecodedAspect(undefined)} />
    </div>
  </div>;
}
