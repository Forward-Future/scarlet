import type { Ctx } from "../context.js";
import { createSkill, updateSkill } from "./skills.js";

/** The single JSON settings row written by earlier releases, before these choices moved to skills. */
interface LegacyDialogueSettings {
  aiCuts?: Partial<Record<"pause" | "filler" | "retake" | "coaching", "cut" | "suggest" | "off">>;
  pauseTightness?: "loose" | "natural" | "tight";
  crossfadeFrames?: number;
}

function editorialPreferences(settings: LegacyDialogueSettings): string[] {
  const lines: string[] = [];
  const kinds = { pause: "pauses", filler: "filler words", retake: "retakes", coaching: "production talk" } as const;
  for (const kind of Object.keys(kinds) as Array<keyof typeof kinds>) {
    const choice = settings.aiCuts?.[kind];
    if (choice === "suggest") lines.push(`Leave the final decision on each proposed removal of ${kinds[kind]} to the editor, even after you check the cut.`);
    if (choice === "off") lines.push(`Keep all ${kinds[kind]}.`);
  }
  if (settings.pauseTightness === "loose") lines.push("Leave generous breathing room around the words at each cut.");
  if (settings.pauseTightness === "tight") lines.push("Keep pauses tight, with little air around the words at each cut.");
  const frames = settings.crossfadeFrames;
  if (frames === 0) lines.push("Use straight audio cuts at dialogue joins.");
  else if (frames !== undefined && Number.isInteger(frames) && frames > 0 && frames <= 12 && frames !== 2) {
    lines.push(`Use a ${frames}-frame audio crossfade at dialogue joins.`);
  }
  return lines;
}

/** Preserve the approval the editor requested for cuts already waiting under the retired setting. */
function preservePendingSuggestions(ctx: Ctx, levels: LegacyDialogueSettings["aiCuts"]) {
  if (!levels || !Object.values(levels).includes("suggest")) return;
  const pending = ctx.repos.changes.select(`state IN ('ready','revising') AND json_extract(json, '$.intent') = 'suggestion'
    AND json_array_length(json_extract(json, '$.cutReasons')) > 0`);
  for (const change of pending) {
    const settled = [...change.cutChoices ?? [], ...change.cutAssessments ?? []];
    const reasons = change.cutReasons!;
    const updated = reasons.map(r => {
      if (!r.kind || levels[r.kind] !== "suggest" || settled.some(a => a.start <= r.start + 1e-5 && a.end >= r.end - 1e-5)) return r;
      return { ...r, legacySuggest: true as const };
    });
    if (updated.some((r, i) => r !== reasons[i])) ctx.repos.changes.put({ ...change, cutReasons: updated });
  }
}

export function migrateDialogueSettings(ctx: Ctx) {
  ctx.db.transaction(() => {
    // ServerSettings strips retired fields. Read the original row, then consume it in the same transaction
    // as the skill revisions so an interrupted upgrade or a second engine cannot import the choices twice.
    const row = ctx.db.prepare("SELECT json_extract(json, '$.dialogue') AS dialogue FROM settings WHERE id = 1 AND json_type(json, '$.dialogue') = 'object'")
      .get() as { dialogue: string } | undefined;
    if (!row) return;
    const legacy: LegacyDialogueSettings = JSON.parse(row.dialogue);
    preservePendingSuggestions(ctx, legacy.aiCuts);
    const lines = editorialPreferences(legacy);
    if (lines.length) {
      const preferences = lines.map(line => `- ${line}`).join("\n");
      const guides = ctx.repos.skills.select(`name = 'dialogue-pass' OR json_extract(json, '$.bundledName') IN ('first-cut-dialogue', 'dialogue-pass')`);
      if (guides.length) {
        for (const guide of guides) {
          // From now on this is the editor's copy. Later seeding must retain both their prose and these choices.
          const source = guide.source === "bundled" || guide.source === "seed" ? undefined : guide.source;
          const content = `${guide.content}\n\n## Editor preferences for dialogue cuts\n\nUse these preferences in place of the general defaults above.\n\n${preferences}\n`;
          updateSkill(ctx, null, { ...guide, source }, { content });
        }
      } else {
        // The editor may have deleted the workflow or chosen an empty library. Keep their choices recoverable
        // without restoring a deleted guide or activating a replacement.
        let name = "dialogue-preferences";
        for (let n = 2; ctx.repos.skills.select("name = ?", [name]).length; n++) name = `dialogue-preferences-${n}`;
        const description = "Preferences saved for dialogue cuts in an earlier version of Scarlet.";
        const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n# Dialogue preferences\n\n${preferences}\n`;
        createSkill(ctx, null, { name, content, description, scope: "team", enabled: false }, { source: "dialogue-settings" });
      }
    }
    ctx.db.prepare("UPDATE settings SET json = json_remove(json, '$.dialogue') WHERE id = 1").run();
  }, "immediate")();
}
