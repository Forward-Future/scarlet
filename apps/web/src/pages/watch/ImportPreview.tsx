import { useEffect, useState } from "react";
import type { MediaAsset } from "@scarlet/timeline";
import { api, loggedFetch, readLoggedBody } from "../../lib/client";
import { isLink } from "../../lib/pendingImports";
import { useUploader } from "../../components/media/UploadDropzone";
import { ImportProgress } from "../../components/media/ImportProgress";

export function ImportPreview({ projectId, preparing, onMedia }: { projectId: string; preparing?: MediaAsset; onMedia(): void }) {
  const { localImport, items } = useUploader(projectId);
  const path = localImport?.path;
  const [frame, setFrame] = useState<{ path: string; url: string }>();
  useEffect(() => {
    // A link is not a file on this computer: the engine has no frame of it until it has downloaded.
    if (!path || isLink(path) || !/\.(mp4|mov|mkv|webm|m4v|avi|mxf|mts|m2ts|png|jpe?g|webp|gif)$/i.test(path)) return;
    const controller = new AbortController();
    let url: string | undefined;
    void (async () => {
      // Correlate the preview with the engine log and record any transfer failure after the headers.
      const response = await loggedFetch(api.url(`/projects/${projectId}/media/import-frame`), {
        method: "POST", signal: controller.signal, body: JSON.stringify({ path }),
        headers: { "Content-Type": "application/json", ...(api.token && { Authorization: `Bearer ${api.token}` }) },
      });
      if (!response.ok) {
        await readLoggedBody(response, () => response.text());
        return;
      }
      const image = await readLoggedBody(response, () => response.blob());
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(image);
      setFrame({ path, url });
    })().catch(() => {}); // The import still reports its own errors and prepares compatible footage.
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [path, projectId]);
  const upload = items.find(item => item.state === "uploading" || item.state === "preparing");
  return <div className="absolute inset-0 flex items-end justify-center p-3">
    {frame && frame.path === path && <img src={frame.url} alt="" className="absolute inset-0 w-full h-full object-contain" />}
    <div className="relative w-full max-w-sm rounded-lg border border-white/15 bg-black/85 px-4 py-3 text-fg">
      <ImportProgress localImport={localImport} upload={upload} preparing={preparing} />
      {!localImport && !upload && preparing && <button className="btn-quiet mt-1" onClick={onMedia}>View media</button>}
    </div>
  </div>;
}
