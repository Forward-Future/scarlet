/** One inventory for Settings and MCP registration. A session is offered the tools its harness can use (its
 * capabilities) and its request calls for: a skill edit or a side check gets only its own few
 * (`tool` in packages/mcp/src/server.ts). */
export const EDITING_TOOL_GROUPS = [
  { title: "Timeline editing", description: "Read the timeline, trim dialogue, frame the picture, sync multi-camera angles, switch cameras and propose changes.",
    tools: ["project_get", "timeline_get", "timeline_at", "timeline_diff", "timeline_propose", "timeline_first_cut", "timeline_sync_multicam", "timeline_switch_cameras", "timeline_crossfade_audio", "timeline_transition", "timeline_framing", "timeline_picture_sync"] },
  { title: "Speech and waveform", description: "Find a line, correct how a name is written, measure pauses and loudness, find the beat of a music track, and check the words and sound at each cut.",
    tools: ["transcript_get", "transcript_search", "transcript_fix", "timeline_transcript", "timeline_join_audit", "waveform_get", "sound_picture", "media_profile", "music_beats", "audio_sync", "dialogue_scan", "dialogue_check_join", "dialogue_check_repeats", "dialogue_apply_cuts", "dialogue_review_inspect", "dialogue_review_save", "dialogue_revise_cut"] },
  { title: "Screen text", description: "Read and search the words shown on screen in a recording, find where the speaker reads them aloud, and see where the picture changes.",
    tools: ["screen_text", "screen_reading", "screen_motion"] },
  { title: "Faces", description: "Find where the people are in the frame and where they look over time, check that their lips keep time with the sound, and match speakers to camera angles.",
    tools: ["faces", "lip_sync", "multicam_analyze"] },
  { title: "Review and delivery", description: "Follow review notes, preview a change and render a delivery.",
    tools: ["change_get", "change_list", "edit_flag", "notes_list", "note_reply", "note_resolve", "render_request", "render_status"] },
  { title: "Requests and skills", description: "Report progress, ask editorial questions, hand a kind of work to the model chosen for it in Task models, use saved instructions and offer rules to add to them.",
    tools: ["task_log", "task_question", "hand_off", "skills_list", "learning_suggest", "skill_save_from_change", "skill_save_edit"] },
  { title: "Motion graphics", description: "Draw graphics from web pages, capture pages and take clips of videos from the web, and read the files and style guide the editor gave.",
    tools: ["graphic_render", "graphic_get", "web_capture", "web_video", "style_guide_save", "style_guide_get", "style_guide_sound_import", "style_guide_update", "style_guide_preview_render", "style_guide_preview_get", "attachment_read"] },
  { title: "Frame inspection", description: "Examine a source frame or several moments from an edit together.",
    tools: ["media_frame", "frame_contact_sheet", "frame_contact_sheet_batch", "screen_area"] },
  { title: "Edit comparison", description: "Listen to source audio, or have a model that hears listen for one that can't, and compare both sides of a suggested edit.",
    tools: ["change_review_cut", "source_audio", "listen"] },
  { title: "Caption generation", description: "Build a caption track from the transcript.",
    tools: ["captions_generate"] },
  { title: "Asset import and timeline export", description: "Bring in new assets and export a timeline to another editor.",
    tools: ["asset_add", "export_otio"] },
] as const satisfies ReadonlyArray<{ title: string; description: string; tools: readonly string[] }>;

export type ScarletToolName = typeof EDITING_TOOL_GROUPS[number]["tools"][number];
const AUTHORING_ONLY_TOOLS = new Set<ScarletToolName>([
  "skill_save_from_change",
  "skill_save_edit",
  "style_guide_update",
  "style_guide_preview_render",
  "style_guide_preview_get",
]);
export const SCARLET_TOOL_NAMES = EDITING_TOOL_GROUPS.flatMap(g => [...g.tools] as ScarletToolName[])
  .filter(name => !AUTHORING_ONLY_TOOLS.has(name));

