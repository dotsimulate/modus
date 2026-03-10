import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openInEditor, readFileContent } from "../api";
import { FileContentViewer } from "./FileContentViewer";

type Props = {
  filePath: string | null;
  onClose: () => void;
};

type ViewerBounds = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type InteractionState =
  | {
      mode: "drag" | "resize";
      edge?: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
      startX: number;
      startY: number;
      bounds: ViewerBounds;
    }
  | null;

const STORAGE_KEY = "chat-file-viewer-bounds";
const MIN_WIDTH = 420;
const MIN_HEIGHT = 260;
const VIEWPORT_MARGIN = 12;
const RESIZE_EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

function getDefaultBounds(): ViewerBounds {
  const minWidth = Math.min(MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const minHeight = Math.min(MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2);
  const width = Math.min(920, Math.max(minWidth, window.innerWidth - 80));
  const height = Math.min(680, Math.max(minHeight, Math.round(window.innerHeight * 0.68)));
  const left = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - 28);
  const top = Math.max(56, window.innerHeight - height - 88);
  return { top, left, width, height };
}

function clampBounds(bounds: ViewerBounds): ViewerBounds {
  const minWidth = Math.min(MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const minHeight = Math.min(MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2);
  const maxWidth = Math.max(minWidth, window.innerWidth - VIEWPORT_MARGIN * 2);
  const maxHeight = Math.max(minHeight, window.innerHeight - VIEWPORT_MARGIN * 2);
  const width = Math.min(Math.max(bounds.width, minWidth), maxWidth);
  const height = Math.min(Math.max(bounds.height, minHeight), maxHeight);
  const left = Math.min(
    Math.max(bounds.left, VIEWPORT_MARGIN),
    Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
  );
  const top = Math.min(
    Math.max(bounds.top, VIEWPORT_MARGIN),
    Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
  );
  return { top, left, width, height };
}

function clampResizeBounds(bounds: ViewerBounds, initial: ViewerBounds, edge: NonNullable<InteractionState>["edge"]): ViewerBounds {
  const minWidth = Math.min(MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const minHeight = Math.min(MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2);
  const maxWidth = Math.max(minWidth, window.innerWidth - VIEWPORT_MARGIN * 2);
  const maxHeight = Math.max(minHeight, window.innerHeight - VIEWPORT_MARGIN * 2);
  const right = initial.left + initial.width;
  const bottom = initial.top + initial.height;
  const next = { ...bounds };

  if (edge?.includes("w")) {
    next.width = Math.min(Math.max(next.width, minWidth), Math.min(maxWidth, right - VIEWPORT_MARGIN));
    next.left = right - next.width;
  } else if (edge?.includes("e")) {
    next.width = Math.min(Math.max(next.width, minWidth), Math.min(maxWidth, window.innerWidth - initial.left - VIEWPORT_MARGIN));
    next.left = initial.left;
  }

  if (edge?.includes("n")) {
    next.height = Math.min(Math.max(next.height, minHeight), Math.min(maxHeight, bottom - VIEWPORT_MARGIN));
    next.top = bottom - next.height;
  } else if (edge?.includes("s")) {
    next.height = Math.min(Math.max(next.height, minHeight), Math.min(maxHeight, window.innerHeight - initial.top - VIEWPORT_MARGIN));
    next.top = initial.top;
  }

  return clampBounds(next);
}

function loadStoredBounds(): ViewerBounds {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultBounds();
    const parsed = JSON.parse(raw) as Partial<ViewerBounds>;
    if (
      typeof parsed.top !== "number" ||
      typeof parsed.left !== "number" ||
      typeof parsed.width !== "number" ||
      typeof parsed.height !== "number"
    ) {
      return getDefaultBounds();
    }
    return clampBounds({
      top: parsed.top,
      left: parsed.left,
      width: parsed.width,
      height: parsed.height,
    });
  } catch {
    return getDefaultBounds();
  }
}

export function ChatFileViewer({ filePath, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bounds, setBounds] = useState<ViewerBounds>(() => loadStoredBounds());
  const [copiedPath, setCopiedPath] = useState(false);
  const interactionRef = useRef<InteractionState>(null);

  useEffect(() => {
    if (!filePath) return;
    let active = true;
    setLoading(true);
    setError(null);
    setContent(null);

    readFileContent(filePath)
      .then((text) => {
        if (!active) return;
        setContent(text);
      })
      .catch(() => {
        if (!active) return;
        setError("Could not load file contents.");
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [filePath]);

  useEffect(() => {
    if (!filePath) return;
    setBounds(loadStoredBounds());
    setCopiedPath(false);
  }, [filePath]);

  useEffect(() => {
    if (!copiedPath) return;
    const timer = window.setTimeout(() => setCopiedPath(false), 1000);
    return () => window.clearTimeout(timer);
  }, [copiedPath]);

  useEffect(() => {
    if (!filePath) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(bounds));
    } catch {
      // Ignore storage failures.
    }
  }, [bounds, filePath]);

  useEffect(() => {
    if (!filePath) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onResize = () => {
      setBounds((prev) => clampBounds(prev));
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [filePath, onClose]);

  useEffect(() => {
    if (!filePath) return;

    const onPointerMove = (e: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction) return;

      const deltaX = e.clientX - interaction.startX;
      const deltaY = e.clientY - interaction.startY;

      if (interaction.mode === "drag") {
        setBounds(clampBounds({
          ...interaction.bounds,
          left: interaction.bounds.left + deltaX,
          top: interaction.bounds.top + deltaY,
        }));
        return;
      }

      const next = { ...interaction.bounds };
      const edge = interaction.edge ?? "se";

      if (edge.includes("e")) {
        next.width = interaction.bounds.width + deltaX;
      }
      if (edge.includes("s")) {
        next.height = interaction.bounds.height + deltaY;
      }
      if (edge.includes("w")) {
        next.width = interaction.bounds.width - deltaX;
        next.left = interaction.bounds.left + deltaX;
      }
      if (edge.includes("n")) {
        next.height = interaction.bounds.height - deltaY;
        next.top = interaction.bounds.top + deltaY;
      }

      setBounds(clampResizeBounds(next, interaction.bounds, edge));
    };

    const onPointerUp = () => {
      interactionRef.current = null;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [filePath]);

  if (!filePath) return null;

  return createPortal(
    <div className="chat-file-viewer-overlay">
      <div className="chat-file-viewer-backdrop" />
      <div
        className="chat-file-viewer-popup"
        style={{
          top: bounds.top,
          left: bounds.left,
          width: bounds.width,
          height: bounds.height,
        }}
      >
        <FileContentViewer
          filePath={filePath}
          content={content}
          loading={loading}
          error={error}
          nameActions={(
            <button
              className={`chat-file-viewer-btn chat-file-viewer-btn--inline${copiedPath ? " is-copied" : ""}`}
              onClick={() => {
                navigator.clipboard.writeText(filePath).then(() => {
                  setCopiedPath(true);
                }).catch(() => {
                  // Ignore clipboard permission/focus failures.
                });
              }}
              title={copiedPath ? "Copied full path" : "Copy full file path"}
              aria-label={copiedPath ? "Copied full file path" : "Copy full file path"}
            >
              {copiedPath ? (
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path
                    d="M2.2 6.4 4.6 8.8 9.8 3.6"
                    stroke="currentColor"
                    strokeWidth="1.35"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <rect x="4.25" y="2.25" width="5.5" height="7.5" rx="0.9" stroke="currentColor" strokeWidth="1.1" />
                  <path d="M2.25 8V3.1c0-.5.4-.85.9-.85h3.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                </svg>
              )}
            </button>
          )}
          onHeaderPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("button")) return;
            e.preventDefault();
            interactionRef.current = {
              mode: "drag",
              startX: e.clientX,
              startY: e.clientY,
              bounds,
            };
          }}
          actions={(
            <>
              <button
                className="chat-file-viewer-btn"
                onClick={() => openInEditor(filePath)}
                title="Open in editor"
                aria-label="Open in editor"
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path
                    d="M10 6.5V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3.5M7 1h4v4M5 7l6-6"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button className="chat-file-viewer-btn" onClick={onClose} title="Close" aria-label="Close">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path
                    d="M2 2L8 8M8 2L2 8"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </>
          )}
        />
        {RESIZE_EDGES.map((edge) => (
          <div
            key={edge}
            className={`chat-file-viewer-resize chat-file-viewer-resize--${edge}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              interactionRef.current = {
                mode: "resize",
                edge,
                startX: e.clientX,
                startY: e.clientY,
                bounds,
              };
            }}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}
