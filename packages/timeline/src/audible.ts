/** Sound a clip plays, shared by the edits that move sound between tracks: crossfades, split edits and picture sync. */
import type { MediaClip, Track } from "./timelineSchema.js";

/** A media clip and the track it sits on. */
export type Placed = { clip: MediaClip; track: Track };

/** Whether a clip is heard: it is on, its volume is up, and its track plays sound and isn't muted. */
export const plays = (track: Track, clip: MediaClip) => !track.muted && track.kind !== "caption" && clip.enabled && clip.volume > 0;
