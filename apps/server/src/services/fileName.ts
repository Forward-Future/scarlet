/** What a file name can't hold on some system: path separators, control characters and the ones Windows reserves. */
const UNSAFE = /[\u0000-\u001f\\/:*?"<>|]+/g;

/** A name with each run of characters a file name can't hold put as `replacement`. */
export function safeFileName(name: string, replacement = " "): string {
  return name.replace(UNSAFE, replacement);
}
