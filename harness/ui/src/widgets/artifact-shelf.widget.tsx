import { useEffect, useState } from "react";
import type { ArtifactShelfItem, ArtifactShelfResponse } from "../../../sdk/index";
import type { WidgetProps } from "./types";
import { useProfiles } from "../providers/ProfileContext";
import { modus } from "../modusClient";
import { PreviewRenderer } from "../components/PreviewRenderer";
import { CopyButton } from "../components/CopyButton";

function fmtSize(size: number | null): string {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export default function ArtifactShelfWidget({ active = true }: WidgetProps) {
  const { activeCwd, activeUserProfile } = useProfiles();
  const [data, setData] = useState<ArtifactShelfResponse | null>(null);
  const [selected, setSelected] = useState<ArtifactShelfItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !activeCwd) return;
    let live = true;
    setError(null);
    modus.artifactShelf({ cwd: activeCwd, userProfile: activeUserProfile ?? undefined, limit: 60 })
      .then((next) => {
        if (!live) return;
        setData(next);
        setSelected((prev) => prev && next.items.some((item) => item.id === prev.id) ? prev : next.items[0] ?? null);
      })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : "Could not load artifacts."); });
    return () => { live = false; };
  }, [active, activeCwd, activeUserProfile]);

  const items = data?.items ?? [];

  return (
    <div className="artifact-shelf">
      <div className="artifact-shelf-list">
        {!activeCwd && <div className="artifact-shelf-empty">no project path</div>}
        {error && <div className="artifact-shelf-empty">{error}</div>}
        {activeCwd && !error && !data && <div className="artifact-shelf-empty">loading artifacts...</div>}
        {data && items.length === 0 && <div className="artifact-shelf-empty">no previewable outputs found</div>}
        {items.map((item) => (
          <button
            key={item.id}
            className={`artifact-shelf-item${selected?.id === item.id ? " artifact-shelf-item--active" : ""}`}
            onClick={() => setSelected(item)}
            title={item.path}
          >
            <span className="artifact-shelf-item-kind">{item.kind}</span>
            <span className="artifact-shelf-item-main">
              <span className="artifact-shelf-item-name">{item.name}</span>
              <span className="artifact-shelf-item-path">{item.pathLabel}</span>
            </span>
            <span className="artifact-shelf-item-size">{fmtSize(item.size)}</span>
          </button>
        ))}
      </div>
      <div className="artifact-shelf-preview">
        {selected ? (
          <PreviewRenderer
            manifest={selected}
            nameActions={<CopyButton value={selected.path} size="inline" title="Copy path" />}
            actions={
              <button className="chat-file-viewer-btn" onClick={() => modus.openInEditor(selected.path)} title="Open in editor">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M10 6.5V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3.5M7 1h4v4M5 7l6-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            }
          />
        ) : (
          <div className="artifact-shelf-empty artifact-shelf-empty--preview">select an artifact</div>
        )}
      </div>
    </div>
  );
}
