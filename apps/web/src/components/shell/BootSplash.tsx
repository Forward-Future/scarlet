import { useEffect, useState } from "react";
import "./boot-splash.css";

/**
 * The window is starting until its first page can show whole: the library once the project list has its first answer,
 * the project Scarlet reopens once it is on screen. Whichever of them still waits shows the startup screen for it.
 */
export const startup = { done: false };

const LINES = [
  "Warming up the engine",
  "Scanning frames",
  "Listening to the audio",
  "Finding the best takes",
  "Lining up the timeline",
];
const LINE_MS = 1800;

// Clip widths (in track units). The two marked `cut` get trimmed out as the playhead passes, then come back.
const CLIPS: { w: number; cut?: boolean }[] = [
  { w: 14 }, { w: 9, cut: true }, { w: 18 }, { w: 11 }, { w: 8, cut: true }, { w: 16 }, { w: 12 },
];
const BARS = 48;

// The screen is drawn again by each part of the window that waits (the window's code, its first page, the engine, the
// project list or the project being reopened). Each one picks the animation up where the last left it.
const shownAt = Date.now();
const elapsed = () => Date.now() - shownAt;
const lineAt = () => Math.floor(elapsed() / LINE_MS) % LINES.length;

/**
 * The one screen the window shows from the moment it opens until its first page is ready: a playhead sweeps a
 * timeline and two clips are cut out. Given a line, it says that instead of the startup lines.
 */
export function BootSplash({ line }: { line?: string }) {
  const [since] = useState(elapsed);
  const [at, setAt] = useState(lineAt);
  // The line that was showing when the screen was drawn again stays where it is, without coming in again.
  const [held, setHeld] = useState(() => (since > 250 ? at : -1));
  useEffect(() => {
    if (line) return;
    let id: ReturnType<typeof setTimeout>;
    const next = () => { id = setTimeout(() => { setAt(lineAt()); setHeld(-1); next(); }, LINE_MS - (elapsed() % LINE_MS)); };
    next();
    return () => clearTimeout(id);
  }, [line]);

  let offset = 0;
  return (
    <main className={`boot-splash${since > 250 ? " is-continued" : ""}`} aria-busy="true"
      style={{ "--since": `${(-since / 1000).toFixed(3)}s` } as React.CSSProperties}>
      <div className="boot-glow" aria-hidden />
      <section className="boot-stage">
        <div className="boot-wordmark" aria-hidden>Scarlet</div>

        <div className="boot-editor" aria-hidden>
          <div className="boot-track">
            {CLIPS.map((clip, i) => {
              const start = offset;
              offset += clip.w;
              return (
                <span
                  key={i}
                  className={`boot-clip${clip.cut ? " is-cut" : ""}`}
                  style={{
                    "--w": clip.w,
                    "--hue": i % 3,
                    // Light each clip up the moment the playhead crosses it.
                    "--at": `${(start / 88) * 2.8}s`,
                  } as React.CSSProperties}
                />
              );
            })}
          </div>
          <div className="boot-wave">
            {Array.from({ length: BARS }, (_, i) => (
              <span key={i} style={{ "--d": `${(-i * 0.09).toFixed(2)}s`, "--h": 0.3 + Math.abs(Math.sin(i * 1.7)) * 0.7 } as React.CSSProperties} />
            ))}
          </div>
          <div className="boot-playhead" />
          <div className="boot-sparks">
            <i /><i /><i />
          </div>
        </div>

        <p role="status" className="boot-line">
          <span key={line ?? at} className={`boot-line-text${!line && at === held ? " is-held" : ""}`}>{line ?? `${LINES[at]}…`}</span>
        </p>
      </section>
    </main>
  );
}
