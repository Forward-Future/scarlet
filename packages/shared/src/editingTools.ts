/** One inventory for Settings and MCP registration. Every tool is always
 * offered; only the harness's capabilities limit what a session sees. */
export const EDITING_TOOL_GROUPS = [
  { title: "Timeline editing", description: "Read the timeline, trim dialogue and propose changes.",
    tools: ["project_get", "timeline_get", "timeline_at", "timeline_diff", "timeline_propose", "timeline_first_cut", "timeline_crossfade_audio", "timeline_transition"] },
  { title: "Speech and waveform", description: "Find a line, measure pauses and loudness, and check the words and sound at each cut.",
    tools: ["transcript_get", "transcript_search", "timeline_transcript", "timeline_join_audit", "waveform_get", "sound_picture", "media_profile", "audio_sync", "dialogue_scan", "dialogue_check_join", "dialogue_check_repeats", "dialogue_apply_cuts", "dialogue_review_inspect", "dialogue_review_save", "dialogue_revise_cut"] },
  { title: "Screen text", description: "Read and search the words shown on screen in a recording.",
    tools: ["screen_text"] },
  { title: "Faces", description: "Find where the people are in the frame, and where they look, over time.",
    tools: ["faces"] },
  { title: "Review and delivery", description: "Follow review notes, preview a change and render a delivery.",
    tools: ["change_get", "change_list", "edit_flag", "notes_list", "note_reply", "note_resolve", "render_request", "render_status"] },
  { title: "Requests and skills", description: "Report progress, ask editorial questions, use saved instructions and offer rules to add to them.",
    tools: ["task_log", "task_question", "skills_list", "learning_suggest", "skill_save_from_change", "skill_save_edit", "shorts_plan"] },
  { title: "Motion graphics", description: "Draw graphics from web pages and saved templates, and read the files and style guide the editor gave.",
    tools: ["graphic_render", "graphic_get", "template_list", "template_get", "template_save", "style_guide_save", "attachment_read"] },
  { title: "Frame inspection", description: "Examine a source frame or several moments from an edit together.",
    tools: ["media_frame", "frame_contact_sheet", "frame_contact_sheet_batch"] },
  { title: "Edit comparison", description: "Listen to source audio or compare both sides of a proposed edit.",
    tools: ["change_review_cut", "source_audio"] },
  { title: "Caption generation", description: "Build a caption track from the transcript.",
    tools: ["captions_generate"] },
  { title: "Asset import and timeline export", description: "Bring in new assets and export a timeline to another editor.",
    tools: ["asset_add", "export_otio"] },
] as const satisfies ReadonlyArray<{ title: string; description: string; tools: readonly string[] }>;

export type ScarletToolName = typeof EDITING_TOOL_GROUPS[number]["tools"][number];
export const SCARLET_TOOL_NAMES = EDITING_TOOL_GROUPS.flatMap(g => [...g.tools] as ScarletToolName[])
  .filter(name => name !== "skill_save_from_change" && name !== "skill_save_edit");

