/** A filename can contain a literal percent sign, including one that is not a URL escape. */
export function decodeImportFilename(name: string): string {
  try { return decodeURIComponent(name); } catch { return name; }
}

export function importLinkFilename(link: string) {
  let url: URL;
  try { url = new URL(link); } catch { return undefined; }
  const encoded = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  const name = decodeImportFilename(encoded);
  return name.includes(".") ? { name, encoded } : undefined;
}
