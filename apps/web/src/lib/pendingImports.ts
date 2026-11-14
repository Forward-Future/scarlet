import { MediaAsset } from "@scarlet/timeline";

/**
 * Imports the editor asked for that haven't finished, kept on this computer so a quit doesn't drop the files
 * still waiting or the one being copied. `source` is an absolute path or an http(s) link. `setsFormat` marks a
 * new project's first files, whose first video gives the project its format. `started` says whether its copy had
 * begun: only such a file can have reached the project before a quit. An entry saved by an older Scarlet has none.
 */
export interface PendingImport { projectId: string; source: string; at: string; setsFormat?: boolean; started?: boolean; importId?: string; interrupted?: boolean }

const KEY = "scarlet.imports.v1";

function read(): PendingImport[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((i): i is PendingImport =>
      !!i && typeof i.projectId === "string" && typeof i.source === "string" && typeof i.at === "string")
      // Only `true` marks a first file. An entry saved with anything else there is still an import to carry on with.
      .map(({ projectId, source, at, setsFormat, started, importId, interrupted }) => ({ projectId, source, at, ...(setsFormat === true && { setsFormat }),
        ...(interrupted === true && { interrupted: true }), ...(typeof started === "boolean" && { started }), ...(importId && MediaAsset.shape.importId.safeParse(importId).success && { importId }) })) : [];
  } catch {
    return [];
  }
}

function write(list: PendingImport[]) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch { /* Without storage the queue lasts for this session only. */ }
}

export function addPendingImports(projectId: string, sources: string[], setsFormat = false) {
  const list = read();
  const at = new Date().toISOString();
  const existing = new Set(list.filter(i => i.projectId === projectId).map(i => i.source));
  for (const source of new Set(sources)) {
    if (!existing.has(source)) list.push({ projectId, source, at, started: false, ...(setsFormat && { setsFormat }) });
  }
  write(list);
}

/** Persist the identity before sending the request, and use it again if this copy was interrupted. */
export function markImportStarted(projectId: string, source: string) {
  const list = read();
  const entry = list.find(i => i.projectId === projectId && i.source === source);
  if (entry?.importId) return entry.importId;
  const importId = crypto.randomUUID();
  if (entry) write(list.map(i => i === entry ? { ...i, started: true, importId } : i));
  return importId;
}

/** Give an interrupted copy one retry, including after Scarlet itself restarts. */
export function retryInterruptedImport(projectId: string, source: string) {
  const list = read();
  const entry = list.find(i => i.projectId === projectId && i.source === source);
  if (!entry || entry.interrupted) return false;
  write(list.map(i => i === entry ? { ...i, interrupted: true } : i));
  return true;
}

export function removePendingImport(projectId: string, source: string) {
  write(read().filter(i => i.projectId !== projectId || i.source !== source));
}

/** The project's format is settled, so the files still waiting leave it alone. */
export function clearSetsFormat(projectId: string) {
  const list = read();
  if (!list.some(i => i.projectId === projectId && i.setsFormat)) return;
  write(list.map(i => i.projectId === projectId ? { ...i, setsFormat: undefined } : i));
}

export function pendingImports(projectId: string) {
  return read().filter(i => i.projectId === projectId);
}

export const isLink = (source: string) => /^https?:\/\//i.test(source);
