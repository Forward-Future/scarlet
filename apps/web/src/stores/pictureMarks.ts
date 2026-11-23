import { create } from "zustand";
import type { PictureMark, PictureMarkKind } from "@scarlet/shared";

/** The frame the editor marked: where it is in the video, and their marks on it, in fractions of the frame. */
export interface MarkedFrame {
  time: number;
  /** The timeline version the frame is on, or none for a source file. */
  version?: string;
  /** The source file the frame is from, when the player shows one. */
  mediaId?: string;
  /** Where the picture of that frame is, as the engine draws it, for its copy by the message box and the one sent. */
  picture?: string;
  marks: PictureMark[];
}

interface PictureMarksState {
  /** The project whose picture takes marks now, or none. */
  marking: string | null;
  tool: PictureMarkKind;
  /** By project: the marked frame the next message carries, as files dropped on the box do. */
  byProject: Record<string, MarkedFrame | undefined>;
  /**
   * Start marking this frame. Marks already made on another frame of the same video stay theirs: the editor goes back
   * to that frame. Marks made on another video are replaced.
   */
  start(projectId: string, at: Omit<MarkedFrame, "marks">): MarkedFrame;
  stop(): void;
  setTool(tool: PictureMarkKind): void;
  add(projectId: string, mark: PictureMark): void;
  replace(projectId: string, index: number, mark: PictureMark): void;
  undo(projectId: string): void;
  /** Take every mark off, and the frame with them. */
  clear(projectId: string): void;
}

export const usePictureMarksStore = create<PictureMarksState>((set, get) => ({
  marking: null,
  tool: "draw",
  byProject: {},
  start: (projectId, at) => {
    const held = get().byProject[projectId];
    const frame = held?.marks.length && held.version === at.version && held.mediaId === at.mediaId ? held : { ...at, marks: [] };
    set(state => ({ marking: projectId, byProject: { ...state.byProject, [projectId]: frame } }));
    return frame;
  },
  stop: () => {
    const { marking, byProject } = get();
    if (!marking) return;
    // A frame left with nothing on it goes with the marking.
    const left = byProject[marking];
    set({ marking: null, ...(left && !left.marks.length && { byProject: { ...byProject, [marking]: undefined } }) });
  },
  setTool: tool => set({ tool }),
  add: (projectId, mark) => set(state => {
    const frame = state.byProject[projectId];
    return frame ? { byProject: { ...state.byProject, [projectId]: { ...frame, marks: [...frame.marks, mark].slice(0, MAX_MARKS) } } } : {};
  }),
  replace: (projectId, index, mark) => set(state => {
    const frame = state.byProject[projectId];
    if (!frame || index < 0 || index >= frame.marks.length) return {};
    const marks = frame.marks.slice();
    marks[index] = mark;
    return { byProject: { ...state.byProject, [projectId]: { ...frame, marks } } };
  }),
  undo: projectId => set(state => {
    const frame = state.byProject[projectId];
    return frame ? { byProject: { ...state.byProject, [projectId]: { ...frame, marks: frame.marks.slice(0, -1) } } } : {};
  }),
  clear: projectId => set(state => ({
    marking: state.marking === projectId ? null : state.marking,
    byProject: { ...state.byProject, [projectId]: undefined },
  })),
}));

/** How many marks one frame takes, as the engine takes them. */
const MAX_MARKS = 20;
