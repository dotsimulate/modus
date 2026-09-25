import { useEffect, useRef, useState } from "react";
import type { PreviewManifest } from "../../../sdk/index";
import { modus } from "../modusClient";

const MAX_BLOB_VIDEO_BYTES = 128 * 1024 * 1024;

export function VideoPreview({ manifest, rawUrl }: { manifest: PreviewManifest; rawUrl: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const attemptedFallback = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const createdUrl = useRef<string | null>(null);

  useEffect(() => () => {
    controller.current?.abort();
    if (createdUrl.current) URL.revokeObjectURL(createdUrl.current);
  }, []);

  const handleError = async () => {
    if (attemptedFallback.current) {
      if (!loading) setFailure("This video could not play in this browser. The file may use an unsupported codec.");
      return;
    }
    attemptedFallback.current = true;
    if (!manifest.urls.raw || manifest.size == null || manifest.size > MAX_BLOB_VIDEO_BYTES) {
      setFailure("This video could not stream in this browser. Try opening it in a video app.");
      return;
    }

    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    try {
      // Some reverse proxies discard media Range requests. A full authenticated
      // fetch lets the browser seek within a local Blob instead.
      const response = await modus.fetch(manifest.urls.raw, { signal: abort.signal });
      if (!response.ok) throw new Error(`Video download failed (${response.status}).`);
      if (response.status !== 200) throw new Error("Video download was incomplete.");
      const length = Number(response.headers.get("Content-Length"));
      if (length > MAX_BLOB_VIDEO_BYTES) throw new Error("This video is too large for browser fallback playback.");
      const downloaded = await response.blob();
      if (downloaded.size > MAX_BLOB_VIDEO_BYTES) throw new Error("This video is too large for browser fallback playback.");
      if (downloaded.size !== manifest.size) throw new Error("Video download was incomplete.");
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([downloaded], { type: manifest.mime }));
      createdUrl.current = url;
      setBlobUrl(url);
      setFailure(null);
    } catch (error) {
      if (!abort.signal.aborted) setFailure(error instanceof Error ? error.message : "Video download failed.");
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  };

  return (
    <div className="preview-media-body preview-media-body--video">
      {!loading && !failure && (
        <video
          key={blobUrl ?? rawUrl}
          src={blobUrl ?? rawUrl}
          controls
          playsInline
          className="preview-video"
          preload="metadata"
          onError={handleError}
        />
      )}
      {loading && <div className="fcv-state" role="status">Loading video for playback...</div>}
      {failure && <div className="fcv-state" role="alert">{failure}</div>}
    </div>
  );
}
