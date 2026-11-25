import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { PictureMark, PictureMarkKind } from "@scarlet/shared";
import { blurOnPointerClick, isInEditableElement } from "../../lib/hotkeys";
import { player } from "../../lib/player";
import { usePlayerStore } from "../../stores/player";
import { usePictureMarksStore, type MarkedFrame } from "../../stores/pictureMarks";
import { Icon } from "../ui/primitives";
import { boxOf, framePoint, isClosedDraw, polylinePoints, thin, translateMark, type FramePoint } from "./pictureMarkGeometry";

/** The marks on a frame, drawn over whatever shows it: the picture on the player, or its small copy by the message box. */
export function MarksDrawing({ marks, live, active, onGrab, onHover }: {
  marks: readonly PictureMark[];
  live?: PictureMark;
  active?: number;
  onGrab?: (index: number, e: ReactPointerEvent) => void;
  onHover?: (index: number | undefined, leaving?: number) => void;
}) {
  const all = live ? [...marks, live] : marks;
  // One mark needs no number. With several, each has its own, so the words can say which.
  const numbered = all.length > 1;
  // A placed mark is grabbed by its line or its number alike.
  const grabHandlers = (i: number, grab: NonNullable<typeof onGrab>) => ({
    onPointerDown: (e: ReactPointerEvent) => grab(i, e),
    onPointerEnter: () => onHover?.(i),
    onPointerLeave: () => onHover?.(undefined, i),
    onClick: (e: ReactMouseEvent) => e.stopPropagation(),
  });
  return <>
    <svg className="picture-marks-lines" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
      {all.map((mark, i) => mark.kind === "box"
        ? <rect key={i} x={mark.box.x} y={mark.box.y} width={mark.box.w} height={mark.box.h} vectorEffect="non-scaling-stroke" data-active={active === i || undefined} />
        : mark.kind === "draw" && mark.points && <polyline key={i} points={polylinePoints(mark.points)} vectorEffect="non-scaling-stroke" data-active={active === i || undefined} />)}
      {onGrab && marks.map((mark, i) => {
        const hitProps = {
          className: "picture-mark-hit",
          "data-mark-index": i,
          vectorEffect: "non-scaling-stroke" as const,
          ...grabHandlers(i, onGrab),
        };
        if (mark.kind === "box") return <rect key={`hit-${i}`} {...hitProps} x={mark.box.x} y={mark.box.y} width={mark.box.w} height={mark.box.h} />;
        if (mark.kind === "draw" && mark.points) {
          return <polyline key={`hit-${i}`} {...hitProps} data-closed={isClosedDraw(mark) || undefined} points={polylinePoints(mark.points)} />;
        }
        return null;
      })}
    </svg>
    {all.map((mark, i) => {
      const grabbable = !!onGrab && i < marks.length;
      const badgeProps = grabbable ? {
        "data-mark-index": i,
        "data-grabbable": "",
        "data-active": active === i || undefined,
        ...grabHandlers(i, onGrab),
      } : {};
      return mark.kind === "point"
        ? <span key={i} className="picture-mark-point" {...badgeProps} style={{ left: `${mark.box.x * 100}%`, top: `${mark.box.y * 100}%` }}>{numbered ? i + 1 : ""}</span>
        : numbered && <span key={i} className="picture-mark-number" {...badgeProps} style={{ left: `${mark.box.x * 100}%`, top: `${mark.box.y * 100}%` }}>{i + 1}</span>;
    })}
  </>;
}

interface MarkToolTip {
  id: string;
  label: string;
  key?: string;
  description: string;
}

const TOOLS: { tool: PictureMarkKind; label: string; key: string; description: string; icon: "pencil" | "box" | "point" }[] = [
  { tool: "draw", label: "Draw", key: "D", description: "Draw freehand on the video to highlight something for your next message.", icon: "pencil" },
  { tool: "box", label: "Box", key: "B", description: "Drag a box around an area on the video for your next message.", icon: "box" },
  { tool: "point", label: "Point", key: "P", description: "Drop a pin on a specific spot in the video for your next message.", icon: "point" },
];

const UNDO_KEY = typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh") ? "⌘Z" : "Ctrl+Z";
const ACTIONS: Record<"undo" | "clear", MarkToolTip> = {
  undo: { id: "undo", label: "Undo", key: UNDO_KEY, description: "Take back the last mark, or put a moved mark back." },
  clear: { id: "clear", label: "Clear marks", description: "Remove all marks from this frame." },
};

/** How far apart, in fractions of the frame, the points kept along a line drawn by hand are. */
const STEP = 0.004;
/** Minimum pointer movement (fraction of the frame) before a grab commits a move. */
const DRAG_MIN = 0.002;

/**
 * The editor's marks on the picture. M (or a tool over the picture) pauses the video and lets them draw on
 * the frame: a line by hand, a box or a point. Placed marks can be grabbed and moved directly on the video.
 * The marks ride on the next message, as a file dropped on the box does, and show on the picture whenever the player rests on their frame.
 */
export function PictureMarks({ projectId, version, mediaId, fps }: { projectId: string; version?: string; mediaId?: string; fps: number }) {
  const frame = usePictureMarksStore(s => s.byProject[projectId]);
  const marking = usePictureMarksStore(s => s.marking === projectId);
  const tool = usePictureMarksStore(s => s.tool);
  const playing = usePlayerStore(s => s.playing);
  const onFrame = usePlayerStore(s => !!frame && Math.abs(s.time - frame.time) < 0.5 / Math.max(1, fps));
  const sameVideo = !!frame && frame.version === version && frame.mediaId === mediaId;
  const [live, setLive] = useState<PictureMark>();
  const [drag, setDrag] = useState<{ index: number; mark: PictureMark }>();
  const [hovered, setHovered] = useState<number>();
  const drawing = useRef<{ start: FramePoint; points: FramePoint[]; id: number }>(undefined);
  const dragging = useRef<{ index: number; origin: PictureMark; start: FramePoint; id: number; moved: boolean }>(undefined);
  const surface = useRef<HTMLDivElement>(null);

  // Playing on, leaving marking, or another video under the player ends any active stroke or drag. The marks stay with the message.
  // Only playback that starts ends the marking: M pressed while the video plays pauses it, and the player hears that
  // it stopped a moment after the marking began.
  const wasPlaying = useRef(playing);
  useEffect(() => {
    const playedOn = playing && !wasPlaying.current;
    wasPlaying.current = playing;
    if (marking && (playedOn || !sameVideo)) usePictureMarksStore.getState().stop();
    if (!marking || playing || !sameVideo) {
      drawing.current = undefined;
      setLive(undefined);
    }
    if (playing || !sameVideo || (!marking && !onFrame)) {
      dragging.current = undefined;
      setDrag(undefined);
      setHovered(undefined);
    }
  }, [marking, playing, sameVideo, onFrame]);
  // Seeking away from the marked frame while paused ends marking so strokes never attach to the wrong frame.
  useEffect(() => {
    if (!marking) return;
    let last = usePlayerStore.getState().time;
    return usePlayerStore.subscribe((state) => {
      if (state.time === last) return;
      last = state.time;
      const current = usePictureMarksStore.getState().byProject[projectId];
      if (!current || Math.abs(state.time - current.time) >= 0.5 / Math.max(1, fps)) {
        usePictureMarksStore.getState().stop();
      }
    });
  }, [marking, projectId, fps]);
  useEffect(() => () => { if (usePictureMarksStore.getState().marking === projectId) usePictureMarksStore.getState().stop(); }, [projectId]);

  // While marking (or dragging a mark), its keys come first, unless the editor is typing: Esc cancels a drag or leaves, ⌘Z takes the last mark off, D B P pick the tool.
  useEffect(() => {
    if (!marking && !drag) return;
    const key = (e: KeyboardEvent) => {
      if (isInEditableElement(e.target) || e.isComposing) return;
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      // A menu or a popover open over the picture closes on its own Esc first, and the marking stays.
      if (e.key === "Escape" && plain && !dragging.current && document.querySelector('[role="menu"], [data-escape-owner], dialog[open], [role="dialog"]')) return;
      if (e.key === "Escape" && plain) {
        if (dragging.current) {
          dragging.current = undefined;
          setDrag(undefined);
        } else if (marking) {
          drawing.current = undefined;
          setLive(undefined);
          usePictureMarksStore.getState().stop();
        } else return;
      } else if (marking) {
        const store = usePictureMarksStore.getState();
        const pick = plain && TOOLS.find(t => t.key.toLowerCase() === e.key.toLowerCase());
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") store.undo(projectId);
        else if (pick) store.setTool(pick.tool);
        else return;
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [marking, drag, projectId]);

  if (!frame || !sameVideo || !(marking || (onFrame && !playing && frame.marks.length))) return null;

  const rawAt = (e: ReactPointerEvent): FramePoint => {
    const box = surface.current!.getBoundingClientRect();
    return [(e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height];
  };
  const at = (e: ReactPointerEvent): FramePoint => framePoint(...rawAt(e));
  /** How far a grabbed mark has travelled from where it was pressed. */
  const dragDelta = (move: { start: FramePoint }, e: ReactPointerEvent) => {
    const cur = rawAt(e);
    return [cur[0] - move.start[0], cur[1] - move.start[1]] as const;
  };
  const shape = (start: FramePoint, points: FramePoint[]): PictureMark | undefined => {
    const end = points[points.length - 1]!;
    if (tool === "point") return { kind: "point", box: { x: end[0], y: end[1], w: 0, h: 0 } };
    const bounds = boxOf(tool === "box" ? [start, end] : points);
    // A press that hardly moved puts a point there.
    if (bounds.w < 0.01 && bounds.h < 0.01) return { kind: "point", box: { x: start[0], y: start[1], w: 0, h: 0 } };
    return tool === "box" ? { kind: "box", box: bounds } : { kind: "draw", box: bounds, points: thin(points) };
  };
  const startGrab = (index: number, e: ReactPointerEvent) => {
    if (e.button !== 0 || drawing.current) return;
    const origin = frame.marks[index];
    if (!origin) return;
    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* a pointer already gone */ }
    dragging.current = { index, origin, start: rawAt(e), id: e.pointerId, moved: false };
    setDrag({ index, mark: origin });
  };
  const onHover = (index: number | undefined, leaving?: number) => {
    setHovered(cur => leaving !== undefined ? (cur === leaving ? undefined : cur) : index);
  };
  const shownMarks = drag ? frame.marks.map((m, i) => i === drag.index ? drag.mark : m) : frame.marks;
  const activeMark = live ? undefined : drag ? drag.index : hovered;

  return <div className="video-surface picture-marks" data-marking={marking || undefined} data-drawing={live ? "" : undefined} data-dragging={drag ? "" : undefined}>
    <div ref={surface} className="video-frame picture-marks-frame"
      onPointerDown={marking ? e => {
        if (e.button !== 0) return;
        e.preventDefault();
        // The line follows the pointer off the picture, and ends where it is let go.
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* a pointer already gone */ }
        const start = at(e);
        drawing.current = { start, points: [start], id: e.pointerId };
        setLive(shape(start, [start]));
      } : undefined}
      onPointerMove={e => {
        const move = dragging.current;
        if (move && move.id === e.pointerId) {
          const [dx, dy] = dragDelta(move, e);
          if (!move.moved && Math.hypot(dx, dy) < DRAG_MIN) return;
          move.moved = true;
          setDrag({ index: move.index, mark: translateMark(move.origin, dx, dy) });
          return;
        }
        if (!marking || usePictureMarksStore.getState().marking !== projectId) return;
        const line = drawing.current;
        if (!line || line.id !== e.pointerId) return;
        const point = at(e);
        const last = line.points[line.points.length - 1]!;
        if (Math.hypot(point[0] - last[0], point[1] - last[1]) < STEP) return;
        line.points.push(point);
        setLive(shape(line.start, line.points));
      }}
      onPointerUp={e => {
        const move = dragging.current;
        if (move && move.id === e.pointerId) {
          dragging.current = undefined;
          setDrag(undefined);
          const [dx, dy] = dragDelta(move, e);
          if (move.moved || Math.hypot(dx, dy) >= DRAG_MIN) {
            usePictureMarksStore.getState().replace(projectId, move.index, translateMark(move.origin, dx, dy));
          }
          return;
        }
        if (!marking || usePictureMarksStore.getState().marking !== projectId) {
          drawing.current = undefined;
          setLive(undefined);
          return;
        }
        const line = drawing.current;
        if (!line || line.id !== e.pointerId) return;
        drawing.current = undefined;
        setLive(undefined);
        const mark = shape(line.start, [...line.points, at(e)]);
        if (mark) usePictureMarksStore.getState().add(projectId, mark);
      }}
      onPointerCancel={() => {
        drawing.current = undefined;
        dragging.current = undefined;
        setLive(undefined);
        setDrag(undefined);
      }}>
      <MarksDrawing marks={shownMarks} live={live} active={activeMark} onGrab={startGrab} onHover={onHover} />
    </div>
  </div>;
}

/**
 * The marking tools, always in a row above the picture. A tool pressed while the video plays pauses it and marks
 * the frame under the playhead; the lit tool pressed again ends the marking.
 */
export function PictureMarkTools({ projectId, enabled, onStart }: { projectId: string; enabled: boolean; onStart: () => void }) {
  const marking = usePictureMarksStore(s => s.marking === projectId);
  const tool = usePictureMarksStore(s => s.tool);
  const count = usePictureMarksStore(s => s.byProject[projectId]?.marks.length ?? 0);
  const [hovered, setHovered] = useState<MarkToolTip>();
  const [focused, setFocused] = useState<MarkToolTip>();
  const tipId = useId();
  const tip = hovered ?? focused;
  const store = usePictureMarksStore.getState();

  useEffect(() => {
    if (!count && (focused?.id === "undo" || focused?.id === "clear")) setFocused(undefined);
  }, [count, focused]);
  useEffect(() => {
    if (!enabled && focused && focused.id !== "undo" && focused.id !== "clear") setFocused(undefined);
  }, [enabled, focused]);

  const pick = (next: PictureMarkKind) => {
    if (marking && tool === next) return store.stop();
    store.setTool(next);
    if (!marking) onStart();
  };
  const wrap = (item: MarkToolTip) => ({
    className: "picture-mark-item",
    onPointerEnter: (e: ReactPointerEvent) => { if (e.pointerType !== "touch") setHovered(item); },
    onPointerLeave: () => setHovered(cur => cur?.id === item.id ? undefined : cur),
  });
  const focusProps = (item: MarkToolTip) => ({
    onFocus: () => setFocused(item),
    onBlur: () => setFocused(cur => cur?.id === item.id ? undefined : cur),
  });

  return <div className="picture-mark-anchor">
    <div className="picture-mark-tools" role="toolbar" aria-label="Mark the picture">
      {TOOLS.map(t => {
        const item: MarkToolTip = { id: t.tool, label: t.label, key: t.key, description: t.description };
        return <span key={t.tool} {...wrap(item)}>
          <button type="button" className="picture-mark-tool" aria-pressed={marking && tool === t.tool} disabled={!enabled}
            aria-label={t.label} aria-describedby={tip?.id === item.id ? tipId : undefined} {...focusProps(item)}
            onClick={e => { blurOnPointerClick(e); pick(t.tool); }}><Icon name={t.icon} size={15} /></button>
        </span>;
      })}
      <i className="picture-mark-sep" aria-hidden="true" />
      <span {...wrap(ACTIONS.undo)}>
        <button type="button" className="picture-mark-tool" aria-label="Undo" disabled={!count}
          aria-describedby={tip?.id === ACTIONS.undo.id ? tipId : undefined} {...focusProps(ACTIONS.undo)}
          onClick={e => { blurOnPointerClick(e); store.undo(projectId); }}><Icon name="undo" size={15} /></button>
      </span>
      <span {...wrap(ACTIONS.clear)}>
        <button type="button" className="picture-mark-tool" aria-label="Clear marks" disabled={!count}
          aria-describedby={tip?.id === ACTIONS.clear.id ? tipId : undefined} {...focusProps(ACTIONS.clear)}
          onClick={e => { blurOnPointerClick(e); store.clear(projectId); }}><Icon name="x" size={15} /></button>
      </span>
    </div>
    {tip && <div id={tipId} role="tooltip" className="picture-mark-tip">
      <span className="picture-mark-tip-head">
        <strong>{tip.label}</strong>
        {tip.key && <kbd>{tip.key}</kbd>}
      </span>
      <span className="picture-mark-tip-desc">{tip.description}</span>
    </div>}
  </div>;
}

/**
 * Whether this Esc is the marking's: it ends the marking, or puts back a mark being dragged, and nothing behind the
 * picture closes on the same press. An edit's card and a marked stretch listen for Esc ahead of the marking, so they ask.
 */
export function marksTakeEscape(e: KeyboardEvent) {
  if (isInEditableElement(e.target) || e.isComposing) return false;
  return usePictureMarksStore.getState().marking !== null || !!document.querySelector(".picture-marks[data-dragging]");
}

/** Mark the frame under the playhead, or go back to the frame already marked. M, or a tool over the picture. */
export function toggleMarking(projectId: string, at: Omit<MarkedFrame, "marks">) {
  const store = usePictureMarksStore.getState();
  if (store.marking === projectId) return store.stop();
  // A video that was playing has run on past the frame by the time it stops: it goes back to the frame marked.
  const wasPlaying = usePlayerStore.getState().playing;
  player.pause();
  const frame = store.start(projectId, at);
  if (wasPlaying || Math.abs(frame.time - at.time) > 1e-6) player.seek(frame.time, true);
}
