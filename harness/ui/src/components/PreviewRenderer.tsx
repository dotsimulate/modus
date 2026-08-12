import { useEffect, useState, type ReactNode } from "react";
import type { PreviewManifest } from "../../../sdk/index";
import { modus } from "../modusClient";
import { SandboxedHtmlFrame } from "./SandboxedHtmlFrame";
import { FileContentViewer } from "./FileContentViewer";

type Props = {
  manifest: PreviewManifest;
  content?: string | null;
  loading?: boolean;
  error?: string | null;
  nameActions?: ReactNode;
  actions?: ReactNode;
  onRequestEdit?: () => void;
};

export function PreviewRenderer({
  manifest,
  content,
  loading = false,
  error = null,
  nameActions,
  actions,
  onRequestEdit,
}: Props) {
  const rawUrl = manifest.urls.raw ? modus.previewUrl(manifest.urls.raw) : "";
  const [text, setText] = useState<string | null>(content ?? null);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);

  useEffect(() => {
    setText(content ?? null);
    setTextError(null);
  }, [content, manifest.id]);

  // Both text and html render from content fetched over an authenticated
  // request. html deliberately does not use manifest.urls.raw: previewUrl()
  // appends the operator bearer token as a query parameter, and an html frame
  // runs scripts, which can always read their own document URL.
  useEffect(() => {
    if (content != null || (manifest.kind !== "text" && manifest.kind !== "html")) return;
    let active = true;
    setTextLoading(true);
    modus.readFile(manifest.path)
      .then((value) => { if (active) setText(value); })
      .catch((err) => { if (active) setTextError(err instanceof Error ? err.message : "Could not load file."); })
      .finally(() => { if (active) setTextLoading(false); });
    return () => { active = false; };
  }, [content, manifest.kind, manifest.path, manifest.id]);

  const header = (
    <div className="fcv-head">
      <div className="fcv-meta">
        <div className="fcv-name-row">
          <span className="fcv-name">{manifest.name}</span>
          {nameActions && <div className="fcv-name-actions">{nameActions}</div>}
        </div>
      </div>
      <div className="fcv-head-side">
        <span className="fcv-count">{manifest.kind}</span>
        {actions && <div className="fcv-actions">{actions}</div>}
      </div>
    </div>
  );

  if (manifest.kind === "image") {
    return (
      <div className="preview-panel preview-panel--image">
        {header}
        <div className="preview-media-body">
          <img src={rawUrl} alt={manifest.name} className="preview-image" />
        </div>
      </div>
    );
  }

  if (manifest.kind === "audio") {
    return (
      <div className="preview-panel">
        {header}
        <div className="preview-media-body preview-media-body--compact">
          <audio src={rawUrl} controls className="preview-audio" preload="metadata" />
        </div>
      </div>
    );
  }

  if (manifest.kind === "video") {
    return (
      <div className="preview-panel">
        {header}
        <div className="preview-media-body">
          <video src={rawUrl} controls className="preview-video" preload="metadata" />
        </div>
      </div>
    );
  }

  if (manifest.kind === "pdf") {
    return (
      <div className="preview-panel">
        {header}
        <iframe className="preview-frame" src={rawUrl} title={manifest.name} sandbox="" />
      </div>
    );
  }

  if (manifest.kind === "html") {
    const htmlLoading = loading || textLoading;
    const htmlError = error || textError;
    return (
      <div className="preview-panel">
        {header}
        {htmlLoading && <div className="fcv-state">Loading file...</div>}
        {!htmlLoading && htmlError && <div className="fcv-state">{htmlError}</div>}
        {!htmlLoading && !htmlError && (
          /*
            srcDoc, not src, and the distinction is a credential boundary rather
            than a preference. Scripts are allowed here where the PDF frame above
            blocks them, because an HTML page that draws itself with JavaScript
            is the common case. But a frame that runs scripts can always read its
            own document URL, and manifest.urls.raw carries the operator bearer
            token in its query string (previewUrl -> tokenParam; /api/file/raw is
            in allowsQueryCredential). Pointing src at it would therefore hand
            that token to the previewed file, which could beacon it anywhere —
            an opaque origin stops the frame reading the app's storage, not its
            own location. With srcDoc there is no URL and no credential to take.
          */
          <SandboxedHtmlFrame
            className="preview-frame"
            html={text ?? ""}
            title={manifest.name}
          />
        )}
      </div>
    );
  }

  return (
    <FileContentViewer
      filePath={manifest.path}
      content={text}
      loading={loading || textLoading}
      error={error || textError}
      nameActions={nameActions}
      actions={actions}
      onRequestEdit={onRequestEdit}
    />
  );
}
