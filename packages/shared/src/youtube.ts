/**
 * YouTube Direct Connect, Publishing Kit drafting, and Resumable Upload API shapes.
 *
 * OAuth tokens and client secrets live strictly in the engine's private local storage
 * and NEVER appear in any schema or response defined here.
 */
import { z } from "zod/v3";
import { Id, Seconds } from "@scarlet/timeline";

export const YouTubeVisibility = z.enum(["private", "unlisted", "public"]);
export type YouTubeVisibility = z.infer<typeof YouTubeVisibility>;

export const YouTubeChannel = z.object({
  id: z.string(),
  title: z.string(),
  handle: z.string().optional(),
  thumbnailUrl: z.string().optional(),
});
export type YouTubeChannel = z.infer<typeof YouTubeChannel>;

export const YouTubeAuthState = z.enum(["disconnected", "connecting", "connected", "error"]);
export type YouTubeAuthState = z.infer<typeof YouTubeAuthState>;

/** Public YouTube connection status returned to Settings and Export. Never contains tokens or secrets. */
export const YouTubeConnectionStatus = z.object({
  state: YouTubeAuthState,
  configured: z.boolean(),
  configSource: z.enum(["env", "custom", "none"]),
  /** Masked hint of the active Google OAuth client ID so the editor can verify which client is configured. */
  clientIdHint: z.string().optional(),
  hasCustomClientId: z.boolean().optional(),
  hasCustomClientSecret: z.boolean().optional(),
  channel: YouTubeChannel.optional(),
  connectedAt: z.string().datetime().optional(),
  /** Active Google OAuth sign-in URL while waiting for the browser callback. */
  authUrl: z.string().optional(),
  error: z.string().optional(),
  needsReconnect: z.boolean().optional(),
});
export type YouTubeConnectionStatus = z.infer<typeof YouTubeConnectionStatus>;

export const YouTubeConfigRequest = z.object({
  clientId: z.string().trim().max(512).nullable().optional(),
  clientSecret: z.string().trim().max(512).nullable().optional(),
});
export type YouTubeConfigRequest = z.infer<typeof YouTubeConfigRequest>;

export const YouTubeChapter = z.object({
  /** Position on the final edited timeline clock (seconds). */
  time: Seconds,
  /** Formatted YouTube chapter timestamp (e.g. "0:00", "2:15", "1:04:12"). */
  timestamp: z.string(),
  title: z.string(),
});
export type YouTubeChapter = z.infer<typeof YouTubeChapter>;

export const YouTubeThumbnailCandidate = z.object({
  id: z.string(),
  /** Final edited timeline clock time (seconds) for extracted frames; omitted for custom image files. */
  time: Seconds.optional(),
  label: z.string(),
  source: z.enum(["auto", "playhead", "custom"]).default("auto"),
  /** Authenticated engine thumbnail path or data URL for previewing in Export. */
  previewUrl: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  score: z.number().optional(),
});
export type YouTubeThumbnailCandidate = z.infer<typeof YouTubeThumbnailCandidate>;

export const YouTubeKitRequest = z.object({
  version: Id.optional(),
  playheadTime: Seconds.optional(),
  useAi: z.boolean().default(true),
});
export type YouTubeKitRequest = z.infer<typeof YouTubeKitRequest>;

export const YouTubePublishingKit = z.object({
  version: Id,
  duration: Seconds,
  title: z.string(),
  titleOptions: z.array(z.string()).default([]),
  description: z.string(),
  chapters: z.array(YouTubeChapter),
  tags: z.array(z.string()),
  thumbnails: z.array(YouTubeThumbnailCandidate),
  draftedWith: z.enum(["ai", "fallback"]),
});
export type YouTubePublishingKit = z.infer<typeof YouTubePublishingKit>;

export const YouTubePublishRequest = z.object({
  version: Id.optional(),
  title: z.string().trim().min(1, "Enter a video title.").max(100, "Title must be 100 characters or fewer."),
  description: z.string().max(5000, "Description must be 5,000 characters or fewer.").default(""),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  visibility: YouTubeVisibility.default("private"),
  thumbnailId: z.string().min(1).max(128).optional(),
  quality: z.enum(["preview", "delivery"]).default("delivery"),
  height: z.number().int().min(2).max(16384).multipleOf(2).optional(),
  bestQuality: z.boolean().optional(),
});
export type YouTubePublishRequest = z.infer<typeof YouTubePublishRequest>;

export const YouTubeUploadPhase = z.enum([
  "queued",
  "rendering",
  "uploading",
  "thumbnail",
  "done",
  "failed",
  "cancelled",
]);
export type YouTubeUploadPhase = z.infer<typeof YouTubeUploadPhase>;

export const YouTubeUploadJob = z.object({
  id: Id,
  projectId: Id,
  version: Id,
  context: z.string(),
  renderId: Id.optional(),
  reusedRender: z.boolean().optional(),
  phase: YouTubeUploadPhase,
  progress: z.number().min(0).max(1),
  bytesUploaded: z.number().nonnegative().optional(),
  bytesTotal: z.number().nonnegative().optional(),
  title: z.string(),
  visibility: YouTubeVisibility,
  videoId: z.string().optional(),
  studioUrl: z.string().optional(),
  watchUrl: z.string().optional(),
  thumbnailWarning: z.string().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
});
export type YouTubeUploadJob = z.infer<typeof YouTubeUploadJob>;
