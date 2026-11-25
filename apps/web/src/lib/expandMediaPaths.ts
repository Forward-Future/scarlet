import { ScarletApiError, type ExpandMediaPathsResponse } from "@scarlet/shared";
import { api, engineUnavailable } from "./client";
import { isLink } from "./pendingImports";

/**
 * Expand any dropped folders into the video files inside them; individual files and http(s) links pass through.
 * Falls back cleanly to the original paths against older engines (404) or while the engine is unreachable.
 */
export async function expandDroppedPaths(paths: string[]): Promise<ExpandMediaPathsResponse> {
  if (!paths.length || paths.every(isLink)) return { files: paths, folders: 0, emptyFolders: [] };
  try {
    return await api.expandMediaPaths(paths);
  } catch (error) {
    if (engineUnavailable(error) || (error instanceof ScarletApiError && error.status === 404)) {
      return { files: paths, folders: 0, emptyFolders: [] };
    }
    throw error;
  }
}

export function emptyFolderMessage(emptyFolders: ReadonlyArray<{ name: string }>): string {
  if (!emptyFolders.length) return "";
  if (emptyFolders.length === 1) return `No video files found in “${emptyFolders[0]!.name}”.`;
  return `No video files found in ${emptyFolders.map(f => `“${f.name}”`).join(", ")}.`;
}
