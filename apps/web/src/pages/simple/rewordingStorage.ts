/** Each project keeps its own: rewording a request in one project leaves the words kept for another as they are. */
const LEGACY_REWORDING_KEY = "scarlet.rewording.v1";
const rewordingKey = (projectId: string) => `${LEGACY_REWORDING_KEY}:${projectId}`;
function readRewording(key: string, projectId: string): { id: string; text: string } | undefined {
  const saved = JSON.parse(localStorage.getItem(key) ?? "null") as { projectId?: unknown; id?: unknown; text?: unknown } | null;
  return saved && saved.projectId === projectId && typeof saved.id === "string" && typeof saved.text === "string" ? { id: saved.id, text: saved.text } : undefined;
}
/** The queued request whose words were in the message box when the project was last on screen, with those words. */
export function savedRewording(projectId: string): { id: string; text: string } | undefined {
  try {
    // Words kept before each project had its own slot are in the one slot all projects shared.
    return readRewording(rewordingKey(projectId), projectId) ?? readRewording(LEGACY_REWORDING_KEY, projectId);
  } catch {
    return undefined;
  }
}
export function saveRewording(projectId: string, rewording: { id: string; text: string } | undefined) {
  try {
    if (rewording) localStorage.setItem(rewordingKey(projectId), JSON.stringify({ projectId, ...rewording }));
    else localStorage.removeItem(rewordingKey(projectId));
    // The shared slot is this project's no longer: its words are in the project's own now, or done with.
    if (readRewording(LEGACY_REWORDING_KEY, projectId)) localStorage.removeItem(LEGACY_REWORDING_KEY);
  } catch { /* Without storage the words last for this session only. */ }
}
