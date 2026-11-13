import type { Ctx } from "../context.js";
import { createSkill } from "./skills.js";

/** Consume legacy rows only after the skill and its first revision are durable. */
export function migrateQuickActions(ctx: Ctx) {
  ctx.db.transaction(() => {
    for (const action of ctx.repos.actions.select()) {
      const base = action.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "edit";
      let name = base;
      let suffix = 2;
      while (ctx.repos.skills.count("name = ?", [name])) name = base + "-" + suffix++;
      const target = action.target === "playhead" ? "the selected moment or range" : "the whole video";
      const description = action.name.replace(/\s+/g, " ").trim();
      const content = [
        "---", "name: " + name, "description: " + JSON.stringify(description), "---", "",
        "When the editor requests this workflow, apply it to " + target + ".", "", action.instruction, "",
      ].join("\n");
      createSkill(ctx, null, { name, description, content, scope: "team" }, { source: "quick-action:" + action.id });
      ctx.repos.actions.remove(action.id);
    }
  }, "immediate")();
}
