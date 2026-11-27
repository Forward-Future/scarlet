import type { YouTubeConnectionStatus, YouTubeUploadJob } from "@scarlet/shared";
import { create } from "zustand";
import { api } from "../lib/client";

interface YouTubeState {
  status: YouTubeConnectionStatus | null;
  loaded: boolean;
  /** Latest upload job per project so progress & Studio link survive closing and reopening Export. */
  uploads: Record<string, YouTubeUploadJob | undefined>;
  loadStatus(): Promise<YouTubeConnectionStatus | null>;
  applyStatus(status: YouTubeConnectionStatus): void;
  loadProjectUploads(projectId: string): Promise<YouTubeUploadJob[]>;
  applyUpload(upload: YouTubeUploadJob): void;
  clearUpload(projectId: string): void;
}

export const useYouTubeStore = create<YouTubeState>((set) => ({
  status: null,
  loaded: false,
  uploads: {},
  async loadStatus() {
    try {
      const { status } = await api.youtubeStatus();
      set({ status, loaded: true });
      return status;
    } catch {
      return null;
    }
  },
  applyStatus(status) {
    set({ status, loaded: true });
  },
  async loadProjectUploads(projectId) {
    try {
      const { uploads } = await api.youtubeUploads(projectId);
      const latest = uploads[0];
      if (latest) {
        set(s => ({ uploads: { ...s.uploads, [projectId]: latest } }));
      }
      return uploads;
    } catch {
      return [];
    }
  },
  applyUpload(upload) {
    set(s => ({ uploads: { ...s.uploads, [upload.projectId]: upload } }));
  },
  clearUpload(projectId) {
    set(s => {
      const uploads = { ...s.uploads };
      delete uploads[projectId];
      return { uploads };
    });
  },
}));
