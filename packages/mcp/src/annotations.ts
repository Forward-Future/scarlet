import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ScarletToolName } from "@scarlet/shared";

/**
 * MCP tool annotations. Harnesses use them to run reads in parallel, retry
 * idempotent calls and decide which calls need approval.
 *
 * Every Scarlet edit creates a new timeline version and stays reversible, so no
 * tool is marked destructive. "Read" tools may start background preparation
 * (transcripts, scans, previews) but never change the project.
 */
const read: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const READ_TOOLS = new Set<string>([
  "project_get", "timeline_get", "timeline_at", "timeline_diff", "timeline_transcript", "timeline_join_audit",
  "transcript_get", "transcript_search", "waveform_get", "sound_picture", "media_profile", "audio_sync",
  "dialogue_scan", "dialogue_check_join", "dialogue_review_inspect",
  "change_get", "change_list", "notes_list", "render_status", "skills_list",
  "media_frame", "frame_contact_sheet", "frame_contact_sheet_batch", "change_review_cut", "source_audio",
]);

/** Add new read-only tools to READ_TOOLS; anything else is treated as a write. */
export function toolAnnotations(name: ScarletToolName | string): ToolAnnotations {
  return READ_TOOLS.has(name) ? read : write;
}
