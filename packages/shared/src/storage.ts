/** A cleanup selection is tied to the Trash generation the user reviewed. */
export interface StorageSelection {
  id: string;
  deletedAt: string | null;
}
export interface StorageProject extends StorageSelection {
  name: string;
  /** When a trashed project is removed for good, as the Trash lists it. Old engines omit this field. */
  purgeAt?: string;
  busy: boolean;
  missingSource: boolean;
  /** Engine-owned, reproducible files relative to the project's segment cache. */
  segments: string[];
}
export interface StorageCleanup {
  kind: "cache" | "trash";
  projects: StorageSelection[];
}
