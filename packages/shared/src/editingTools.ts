import { z } from "zod/v3";

/** One inventory for Settings and MCP registration. Essentials stay available
 * across tasks; only optional groups have a preference key. */
export const OptionalToolGroup = z.enum(["pictures", "auditions", "captions", "exchange"]);
export const EditingTools = z.record(OptionalToolGroup, z.boolean());
export type EditingTools = z.infer<typeof EditingTools>;

export const EDITING_TOOL_GROUPS = [
  { title: "Timeline editing", description: "Read the timeline, trim dialogue and propose changes.", preference: null,
    tools: ["project_get", "timeline_get", "timeline_at", "timeline_diff", "timeline_propose", "timeline_first_cut", "timeline_crossfade_audio"] },
  { title: "Speech and waveform", description: "Find a line, measure pauses and loudness, and check the words and sound at each cut.", preference: null,
    tools: ["transcript_get", "transcript_search", "timeline_transcript", "timeline_join_audit", "waveform_get", "sound_picture", "media_profile", "audio_sync", "dialogue_scan", "dialogue_check_join", "dialogue_check_repeats", "dialogue_apply_cuts", "dialogue_review_inspect", "dialogue_review_save", "dialogue_revise_cut"] },
  { title: "Review and delivery", description: "Follow review notes, preview a change and render a delivery.", preference: null,
    tools: ["change_get", "change_list", "notes_list", "note_reply", "note_resolve", "render_request", "render_status"] },
  { title: "Requests and skills", description: "Report progress, ask editorial questions, use saved instructions and offer rules to add to them.", preference: null,
    tools: ["task_log", "task_question", "skills_list", "learning_suggest", "skill_save_from_change", "skill_save_edit"] },
  { title: "Frame inspection", description: "Examine a source frame or several moments from an edit together.", preference: "pictures",
    tools: ["media_frame", "frame_contact_sheet", "frame_contact_sheet_batch"] },
  { title: "Edit comparison", description: "Listen to source audio or compare both sides of a proposed edit.", preference: "auditions",
    tools: ["change_review_cut", "source_audio"] },
  { title: "Caption generation", description: "Build a caption track from the transcript.", preference: "captions",
    tools: ["captions_generate"] },
  { title: "Asset import and timeline export", description: "Bring in new assets and export a timeline to another editor.", preference: "exchange",
    tools: ["asset_add", "export_otio"] },
] as const satisfies ReadonlyArray<{ title: string; description: string; preference: z.infer<typeof OptionalToolGroup> | null; tools: readonly string[] }>;

export type ScarletToolName = typeof EDITING_TOOL_GROUPS[number]["tools"][number];
export const SCARLET_TOOL_NAMES = EDITING_TOOL_GROUPS.flatMap(g => [...g.tools] as ScarletToolName[])
  .filter(name => name !== "skill_save_from_change" && name !== "skill_save_edit");

export function disabledEditingTools(preferences: EditingTools): Set<ScarletToolName> {
  return new Set(EDITING_TOOL_GROUPS.filter(g => g.preference && preferences[g.preference] === false)
    .flatMap(g => [...g.tools] as ScarletToolName[]));
}
