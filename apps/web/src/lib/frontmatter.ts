/** Read flat display fields, retaining the complete header for edits. */
export interface Frontmatter {
  name?: string;
  description?: string;
  [key: string]: string | undefined;
}

export interface SplitSkill {
  frontmatter: Frontmatter;
  header?: string;
  body: string;
}

/**
 * A header value without its quotes. A double-quoted one is read as the JSON it was written as, so a quote, a
 * backslash or a line break in a description comes back as typed, not as escape codes that Save would store.
 */
function unquote(value: string): string {
  if (/^".*"$/.test(value)) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch { /* not JSON: read as before */ }
  }
  return value.replace(/^["'](.*)["']$/, "$1");
}

export function splitFrontmatter(content: string): SplitSkill {
  const opening = /^---\r?\n/.exec(content);
  if (!opening) return { frontmatter: {}, body: content };
  const rest = content.slice(opening[0].length);
  const closing = /^---(?:\r?\n|$)/m.exec(rest);
  if (!closing) return { frontmatter: {}, body: content };
  const headerEnd = opening[0].length + closing.index + closing[0].length;
  const fm: Frontmatter = {};
  for (const line of rest.slice(0, closing.index).split(/\r?\n/)) {
    const kv = /^(["']?)([A-Za-z0-9_-]+)\1:[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    fm[kv[2]!] = unquote(kv[3]!);
  }
  return { frontmatter: fm, header: content.slice(0, headerEnd), body: content.slice(headerEnd) };
}

export function composeSkill(fields: { name: string; description: string }, body: string, original?: SplitSkill): string {
  const eol = original?.header?.startsWith("---\r\n") ? "\r\n" : "\n";
  let header = original?.header ?? "---\n---\n";
  for (const key of ["name", "description"] as const) {
    if (original?.header && original.frontmatter[key] === fields[key]) continue;
    const value = fields[key];
    const line = `${key}: ${/^[\w][\w .,-]*$/.test(value) ? value : JSON.stringify(value)}`;
    const existing = new RegExp(`^(["']?)${key}\\1:[^\\r\\n]*(?:\\r?\\n(?:[ \\t]*\\r?\\n)*[ \\t]+[^\\r\\n]*)*`, "m");
    if (existing.test(header)) header = header.replace(existing, () => line);
    else header = header.replace(/\r?\n---(?:\r?\n)?$/, match => eol + line + match);
  }
  if (!header.endsWith("\n") && body) header += eol;
  return header + (original?.header ? body : eol + body.replace(/^\n+/, ""));
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
