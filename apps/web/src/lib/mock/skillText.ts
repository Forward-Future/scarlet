import type { Change } from "@scarlet/timeline";

/** A skill-edit request, added as a section at the end of the instructions (the demo has no model). */
export function withEditorRequest(content: string, prompt: string): string {
  return `${content.trimEnd()}\n\n## From the editor\n\n${prompt.trim()}\n`;
}

/**
 * A learning's rule in a skill: it takes the place of the first passage it replaces that the skill still has, and
 * the others go, or it goes in at the end of the instructions when it replaces nothing.
 */
export function withLearning(content: string, rule: string, replaces: string[] | undefined): string {
  const [first, ...rest] = (replaces ?? []).filter(q => content.includes(q));
  return first ? rest.reduce((text, q) => text.replace(q, "").replace(/ {2,}/g, " "), content.replace(first, rule))
    : `${content.trimEnd()}\n\n${rule}\n`;
}

/** The SKILL.md the demo writes for a skill saved from an approved change. */
export function skillFromChangeContent(name: string, changeId: string, change: Change): string {
  const approvedRanges = change.ranges.filter((_, index) => !change.approvedSpots || change.approvedSpots.includes(index));
  return `---\nname: ${name}\ndescription: ${JSON.stringify(change.description)}\n---\n\n# ${name}\n\nLearned from change ${changeId}.\n\n1. ${change.description}\n2. Keep the affected range tight (${approvedRanges.map((r) => `${r.start.toFixed(1)}–${r.end.toFixed(1)} s`).join(", ") || "whole timeline"}).\n`;
}
