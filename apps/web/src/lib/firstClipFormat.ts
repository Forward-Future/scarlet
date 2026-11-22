import { hasInitialTimeline, ProjectSettings, videoFormat, type MediaAsset, type Project } from "@scarlet/timeline";
import { useProjectStore } from "../stores/project";
import { errorMessage } from "./client";
import { clearSetsFormat, pendingImports } from "./pendingImports";

type Snapshot = Pick<Project, "id" | "settings" | "head">;

type Format = NonNullable<ReturnType<typeof videoFormat>>;

/** Shapes a video is published in, best first. A shape that is none of them, such as a laptop screen's, comes last. */
const SHAPES = ["16:9", "9:16", "1:1", "4:5"];
const rank = (format: Format) => {
  const at = SHAPES.indexOf(format.aspect!);
  return at < 0 ? SHAPES.length : at;
};

/** Whether one video's format is better than another's: a better shape, or the same shape at a larger size. */
const better = (current: Format, other: Format) =>
  rank(other) < rank(current) || (rank(other) === rank(current) && other.width! * other.height! > current.width! * current.height!);

/** A new project's format, chosen from every video of its first files once they are all in. */
export interface FormatMatch {
  /** A file of the batch that reached the project. */
  add(media: MediaAsset): void;
  /** Every file of the batch is in: give the project the best format among their videos. */
  settle(): Promise<void>;
}

function matcher(project: Snapshot, quiet: boolean): FormatMatch {
  let best: Format | undefined;
  const add = (media: MediaAsset) => {
    const format = videoFormat(media);
    if (format && (!best || better(best, format))) best = format;
  };
  return {
    add,
    async settle() {
      try {
        if (best) await useProjectStore.getState().updateProject({ settings: best, expectedFormat: { settings: project.settings, head: project.head } }, project.id);
      } catch (error) {
        if (!quiet) throw new Error(`Couldn’t set the project’s format from its videos: ${errorMessage(error)}`);
      } finally {
        // The first files have had their say, so a file still waiting never sets the format at a later launch.
        clearSetsFormat(project.id);
      }
    },
  };
}

/**
 * A new project takes the best format among the videos of its first files, set once every one of them is in, so
 * the order they arrive in doesn't matter: 16:9, then 9:16, 1:1 and 4:5, before any other shape (a screen
 * recording's own), and the larger size of the same shape. The engine sets it only while the project is still as
 * `project` shows it, so an edit or a format the editor chose in the meantime stands.
 */
export const matchFirstClip = (project: Snapshot) => matcher(project, false);

/** Whether a project is still as every project starts: no edit, and the format every project starts with. */
function isNew(project: Snapshot) {
  const fresh = ProjectSettings.parse({});
  return hasInitialTimeline(project) && (Object.keys(fresh) as (keyof ProjectSettings)[]).every(key => project.settings[key] === fresh[key]);
}

/**
 * Files added to a project after it was created empty give it the best format among their videos the same way,
 * from its screen or its card. That holds while the project is still new and has no video yet. When files already setting
 * its format are waiting, the match is theirs, so later files leave it to them.
 */
export function matchAddedClip(project: Snapshot, hasVideo: boolean) {
  if (hasVideo || !isNew(project) || pendingImports(project.id).some(i => i.setsFormat)) return;
  return matchFirstClip(project);
}

/**
 * The same match for first files a quit interrupted. The project as it was created isn't kept, so the one on
 * screen has to show it is still new. Otherwise its format stands and the waiting files stop setting it. First
 * files that arrived before the quit are added to it as the ones still to come are. A resumed file imported fine,
 * so a match that fails stays quiet.
 */
export function resumeFirstClip(projectId: string) {
  const current = useProjectStore.getState().current;
  if (current?.id !== projectId) return;
  if (isNew(current.project)) return matcher(current.project, true);
  clearSetsFormat(projectId);
}

/**
 * Whether first files a quit interrupted can resume yet. Only the project on screen can show whether it is still
 * new, so until theirs is, they stay saved with their marks.
 */
export const canResumeFirstClip = (projectId: string) => useProjectStore.getState().current?.id === projectId;
