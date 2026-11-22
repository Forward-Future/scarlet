import { composeSkill, slugify, type SplitSkill } from "../../lib/frontmatter";
import { normalizeSkillLines } from "../../components/agent/SkillFind";

/** Unsaved edits as they are kept on this computer, with the version of the skill they were made on. */
export interface Draft { name?: string; description?: string; body: string; enabled?: boolean; version?: number }

const isDraft = (draft: unknown): draft is Draft => !!draft && typeof (draft as Draft).body === "string";

function stored(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

export function readDraft(key: string): Draft | null {
  const draft = stored(key);
  return isDraft(draft) ? draft : null;
}

/** The sets of edits that wait beside the page, the latest first. */
export function readKept(key: string): Draft[] {
  const all = stored(key);
  return Array.isArray(all) ? all.filter(isDraft) : [];
}

export function writeDraft(key: string, kept: Draft | Draft[] | null) {
  try {
    if (!kept || (Array.isArray(kept) && !kept.length)) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(kept));
  } catch { /* Storage is optional. */ }
}

/** Compare what the page holds using the textarea's line endings. */
export const pageOf = (name: string, description: string, body: string, enabled: boolean, original?: SplitSkill) =>
  JSON.stringify([name, enabled, normalizeSkillLines(composeSkill({ name: slugify(name) || name, description }, body, original))]);
