/**
 * Nano Banana widget — image gallery in the right panel.
 * Polls the `list` op and displays generated images as thumbnails.
 * Clicking an image shows it full-size.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { MoveWidgetProps } from "../../../../harness/ui/src/components/MoveWidget";

interface ImageEntry {
  filename: string;
  path: string;
  createdAt: number;
}

const colors = {
  bg: "var(--bg, #000)",
  surface: "var(--bg-surface, #111)",
  border: "var(--border, #2a2a2a)",
  text: "var(--text, #e0e0e0)",
  textDim: "var(--text-dim, #666)",
  textLabel: "var(--text-label, #aaa)",
};

const s = {
  root: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    padding: "12px",
    gap: "10px",
    background: colors.bg,
    fontFamily: "var(--font-mono, monospace)",
    overflowY: "auto" as const,
  },
  header: {
    display: "flex",
    justifyContent: "space-between" as const,
    alignItems: "center" as const,
  },
  title: {
    fontSize: "11px",
    color: colors.textLabel,
    letterSpacing: "0.06em",
    textTransform: "uppercase" as const,
  },
  count: {
    fontSize: "11px",
    color: colors.textDim,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
    gap: "8px",
  },
  thumb: {
    width: "100%",
    aspectRatio: "1",
    objectFit: "cover" as const,
    borderRadius: "4px",
    border: `1px solid ${colors.border}`,
    cursor: "pointer",
    transition: "border-color 0.15s",
  },
  thumbLabel: {
    fontSize: "9px",
    color: colors.textDim,
    marginTop: "2px",
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
  },
  overlay: {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(0,0,0,0.85)",
    display: "flex",
    alignItems: "center" as const,
    justifyContent: "center" as const,
    zIndex: 9999,
    cursor: "pointer",
  },
  fullImage: {
    maxWidth: "90%",
    maxHeight: "90%",
    objectFit: "contain" as const,
    borderRadius: "6px",
  },
  empty: {
    fontSize: "12px",
    color: colors.textDim,
    textAlign: "center" as const,
    padding: "24px 0",
  },
};

export default function NanaBananaWidget({ callOp }: MoveWidgetProps) {
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevCount = useRef(0);

  const refresh = useCallback(async () => {
    const res = await callOp("list");
    if (!res.ok || !res.message) return;
    try {
      const data = JSON.parse(res.message) as { images: ImageEntry[] };
      setImages(data.images);
    } catch {
      // ignore
    }
  }, [callOp]);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refresh]);

  const imgSrc = (absPath: string) => {
    const token = localStorage.getItem("harness_token") || "";
    const params = new URLSearchParams({ path: absPath });
    if (token) params.set("token", token);
    return `/api/file-serve?${params.toString()}`;
  };

  return (
    <div style={s.root}>
      <div style={s.header}>
        <span style={s.title}>Generated Images</span>
        <span style={s.count}>{images.length} image{images.length !== 1 ? "s" : ""}</span>
      </div>

      {images.length === 0 ? (
        <div style={s.empty}>No images yet. Ask the agent to generate some.</div>
      ) : (
        <div style={s.grid}>
          {images.map((img) => (
            <div key={img.filename}>
              <img
                src={imgSrc(img.path)}
                alt={img.filename}
                style={s.thumb}
                onClick={() => setSelected(img.path)}
                onMouseOver={(e) => { (e.target as HTMLElement).style.borderColor = colors.text; }}
                onMouseOut={(e) => { (e.target as HTMLElement).style.borderColor = colors.border; }}
              />
              <div style={s.thumbLabel}>{img.filename}</div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div style={s.overlay} onClick={() => setSelected(null)}>
          <img src={imgSrc(selected)} alt="Full size" style={s.fullImage} />
        </div>
      )}
    </div>
  );
}
