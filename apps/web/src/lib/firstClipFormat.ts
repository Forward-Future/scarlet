import { hasInitialTimeline, ProjectSettings, videoFormat, type MediaAsset, type Project } from "@scarlet/timeline";
import { useProjectStore } from "../stores/project";
import { errorMessage } from "./client";
import { clearSetsFormat, pendingImports } from "./pendingImports";

type Snapshot = Pick<Project, "id" | "settings" | "head">;

function matcher(project: Snapshot, quiet: boolean) {
  let matched = false;
  return async (media: MediaAsset) => {
    const format = !matched && videoFormat(media);
    if (!format) return;
    matched = true;
    try {
      await useProjectStore.getState().updateProject({ settings: format, expectedFormat: { settings: project.settings, head: project.head } }, project.id);
    } catch (error) {
      if (!quiet) throw new Error(`Couldn’t match the first clip’s format: ${errorMessage(error)}`);
    } finally {
      // The first video has had its turn, so a file still waiting never sets the format at a later launch.
      clearSetsFormat(project.id);
    }
  };
}

/**
 * A new project takes the format of the first video among its first files. Run the result on each file as it
 * arrives. The engine sets the format only while the project is still as `project` shows it, so an edit or a
 * format the editor chose in the meantime stands.
 */
export const matchFirstClip = (project: Snapshot) => matcher(project, false);

/** Whether a project is still as every project starts: no edit, and the format every project starts with. */
function isNew(project: Snapshot) {
  const fresh = ProjectSettings.parse({});
  return hasInitialTimeline(project) && (Object.keys(fresh) as (keyof ProjectSettings)[]).every(key => project.settings[key] === fresh[key]);
}

/**
 * Files added to a project after it was created empty give it their first video's format the same way, from its
 * screen or its card. That holds while the project is still new and has no video yet. When files already setting
 * its format are waiting, the first video is among them, so later files leave the match to them.
 */
export function matchAddedClip(project: Snapshot, hasVideo: boolean) {
  if (hasVideo || !isNew(project) || pendingImports(project.id).some(i => i.setsFormat)) return;
  return matchFirstClip(project);
}

/**
 * The same match for first files a quit interrupted. The project as it was created isn't kept, so the one on
 * screen has to show it is still new. Otherwise its format stands and the waiting files stop setting it. A resumed
 * file imported fine, so a match that fails stays quiet.
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
