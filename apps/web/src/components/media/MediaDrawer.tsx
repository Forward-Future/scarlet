import { lazy, Suspense } from "react";
import { Drawer, Loading } from "../ui/primitives";
import { Dropzone, type useUploader } from "./UploadDropzone";

const MediaPage = lazy(async () => ({ default: (await import("../../pages/MediaPage")).MediaPage }));

export function MediaDrawer({ uploads, notice, onPlay, onClose }: {
  uploads: ReturnType<typeof useUploader>;
  notice?: string;
  onPlay(id: string): void;
  onClose(): void;
}) {
  return (
    <Drawer open title="Media" width={600} onClose={onClose} wrapContents={contents => (
      <Dropzone className="flex flex-1 min-h-0 flex-col" label="Drop to add files" notice={notice}
        onFiles={uploads.start} onPaths={uploads.startPaths}>
        {contents}
      </Dropzone>
    )}>
      <Suspense fallback={<Loading label="Opening media…" />}><MediaPage uploads={uploads} onPlay={onPlay} /></Suspense>
    </Drawer>
  );
}
