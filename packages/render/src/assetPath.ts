import fs from "node:fs";
import path from "node:path";

function containsFile(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Check the spelling before touching the filesystem (including UNC paths),
 * then check the real target so symlinks cannot leave the trusted directory. */
export function fileInDirectory(directory: string, name: string): string | undefined {
  const root = path.resolve(directory);
  const file = path.resolve(root, name);
  if (!containsFile(root, file)) return undefined;
  try {
    const target = fs.realpathSync(file);
    return containsFile(fs.realpathSync(root), target) && fs.statSync(target).isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve request-time paths asynchronously so a busy media drive does not hold up other engine requests.
 */
export async function fileInDirectoryAsync(directory: string, name: string): Promise<string | undefined> {
  const root = path.resolve(directory);
  const file = path.resolve(root, name);
  if (!containsFile(root, file)) return undefined;
  try {
    const [target, realRoot] = await Promise.all([fs.promises.realpath(file), fs.promises.realpath(root)]);
    return containsFile(realRoot, target) && (await fs.promises.stat(target)).isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}
