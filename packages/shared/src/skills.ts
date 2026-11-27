/** The editor's skills and their history. */
import { z } from "zod/v3";
import { Author, Id } from "@scarlet/timeline";
import { AgentId, RunChoice } from "./agents.js";

export const SkillSlug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const Skill = z.object({
  id: Id,
  /** Folder name, which is also its command. Code never looks a skill up by a name of its own choosing. */
  name: SkillSlug,
  description: z.string(),
  /** Full SKILL.md contents including frontmatter. */
  content: z.string(),
  // Keep the original global scope on the wire for older desktop hosts.
  scope: z.literal("team"),
  ownerId: z.null().default(null),
  projectId: z.null().default(null),
  /** Older clients expect an empty list for a skill available to every agent. */
  agents: z.array(AgentId).default([]).transform((): AgentId[] => []),
  enabled: z.boolean().default(true),
  version: z.number().int().default(1),
  /** Original shipped name, retained when the editor customizes the guide. */
  bundledName: SkillSlug.optional(),
  /** "bundled" or "seed" while a skill Scarlet came with is unedited, then unset. Otherwise where an added skill came from. */
  source: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type Skill = z.infer<typeof Skill>;

export const SkillVersion = z.object({
  version: z.number().int(),
  content: z.string(),
  author: Author.optional(),
  createdAt: z.string().datetime().optional(),
  /**
   * What this version changed, in one line, for the skill's history. A version Scarlet wrote for a request carries
   * the editor's words for it, or the rule they approved in Learnings (`from` says which). Any other version is named
   * from its difference with the one before: the parts of the skill it added, removed or changed.
   */
  note: z.string().optional(),
  from: z.enum(["request", "learning"]).optional(),
});
export type SkillVersion = z.infer<typeof SkillVersion>;

export const UpsertSkillRequest = Skill.pick({
  name: true,
  description: true,
  content: true,
  scope: true,
  projectId: true,
  agents: true,
  enabled: true,
}).partial({ scope: true, projectId: true, agents: true, enabled: true, description: true });
export type UpsertSkillRequest = z.infer<typeof UpsertSkillRequest>;

/** What the editor wants changed in a skill, in their words, and the model they chose to do it. */
export const EditSkillRequest = RunChoice.extend({
  prompt: z.string().trim().min(1).max(8000),
});
export type EditSkillRequest = z.infer<typeof EditSkillRequest>;
