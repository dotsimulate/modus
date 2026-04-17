/**
 * Pages browser widget — lists all DashboardPages available for the project.
 *
 * Groups by origin (standalone/project first, then harness, moves, actions,
 * missions). Each row: title, id, layout/block hint, "open" and "fork" buttons.
 *
 * open  → calls onNavigate(`page:${id}`)
 * fork  → POSTs /api/pages/fork (not yet implemented server-side).
 *         Until the endpoint exists, the button is disabled with a tooltip.
 */

import { useCallback, useEffect, useState } from "react";
import { API_BASE, authHeaders } from "../modusClient";
import { useProfiles } from "../providers/ProfileContext";
import type { WidgetProps } from "./types";
import type { View } from "../views";
import { WidgetEmptyState } from "./widget-components";

type ApiPage = {
  id: string;
  title: string;
  blocks?: unknown[];
  layout?: unknown;
  padding?: number;
  source?: string;
  origin?: "standalone" | "harness" | "move" | "action" | "mission";
};

type GroupKey = "standalone" | "harness" | "move" | "action" | "mission";

const GROUP_ORDER: GroupKey[] = ["standalone", "harness", "move", "action", "mission"];
const GROUP_LABELS: Record<GroupKey, string> = {
  standalone: "project",
  harness: "harness",
  move: "moves",
  action: "actions",
  mission: "missions",
};

// Set to true once a POST /api/pages/fork endpoint ships.
const FORK_ENDPOINT_READY = true;

type Props = WidgetProps & {
  projectCwdOverride?: string;
};

export default function PagesBrowserWidget({ onNavigate, projectCwdOverride }: Props) {
  const { activeUP, activeCwd, projectRoot } = useProfiles();
  const cwd = projectCwdOverride ?? projectRoot ?? activeCwd ?? activeUP?.projects?.[0] ?? null;

  const [pages, setPages] = useState<ApiPage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);
  const [forkMessage, setForkMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!cwd) {
      setPages([]);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/pages?cwd=${encodeURIComponent(cwd)}`, {
      headers: authHeaders(),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setPages(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        setError(`failed to load pages: ${err?.message ?? err}`);
        setPages([]);
      })
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => {
    load();
  }, [load]);

  const handleOpen = useCallback(
    (id: string) => {
      onNavigate(`page:${id}` as View);
    },
    [onNavigate],
  );

  const handleFork = useCallback(
    async (pageId: string) => {
      if (!cwd || !FORK_ENDPOINT_READY) return;
      setForking(pageId);
      setForkMessage(null);
      try {
        const res = await fetch(`${API_BASE}/api/pages/fork`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ cwd, pageId }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        setForkMessage(`forked ${pageId}`);
        load();
      } catch (err: any) {
        setForkMessage(`fork failed: ${err?.message ?? err}`);
      } finally {
        setForking(null);
        setTimeout(() => setForkMessage(null), 3000);
      }
    },
    [cwd, load],
  );

  if (!cwd) return <WidgetEmptyState>no project selected</WidgetEmptyState>;
  if (loading && pages.length === 0) return <WidgetEmptyState>loading pages...</WidgetEmptyState>;
  if (error) return <WidgetEmptyState>{error}</WidgetEmptyState>;
  if (pages.length === 0) return <WidgetEmptyState>no pages available</WidgetEmptyState>;

  // Group by origin (default bucket = standalone when missing)
  const buckets: Record<GroupKey, ApiPage[]> = {
    standalone: [],
    harness: [],
    move: [],
    action: [],
    mission: [],
  };
  for (const p of pages) {
    const key: GroupKey = (p.origin as GroupKey) ?? "standalone";
    (buckets[key] ?? buckets.standalone).push(p);
  }

  return (
    <div className="pages-browser">
      {forkMessage && <div className="pages-browser-toast">{forkMessage}</div>}
      {GROUP_ORDER.map((key) => {
        const items = buckets[key];
        if (!items.length) return null;
        return (
          <div key={key} className="pages-browser-group">
            <div className="pages-browser-group-header">
              <span className="pages-browser-group-label">{GROUP_LABELS[key]}</span>
              <span className="pages-browser-group-count">{items.length}</span>
            </div>
            <div className="pages-browser-list">
              {items.map((p) => {
                const layoutCount = countLayoutWidgets(p);
                const canFork = key !== "standalone";
                return (
                  <div key={`${key}:${p.id}`} className="pages-browser-row">
                    <div className="pages-browser-row-main">
                      <span className="pages-browser-row-title">{p.title}</span>
                      <span className="pages-browser-row-id">{p.id}</span>
                    </div>
                    <div className="pages-browser-row-meta">
                      {layoutCount > 0 && (
                        <span className="pages-browser-row-count">
                          {layoutCount} widget{layoutCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                    <div className="pages-browser-row-actions">
                      <button
                        type="button"
                        className="pages-browser-btn"
                        onClick={() => handleOpen(p.id)}
                      >
                        open
                      </button>
                      {canFork && (
                        <button
                          type="button"
                          className="pages-browser-btn pages-browser-btn--secondary"
                          onClick={() => handleFork(p.id)}
                          disabled={!FORK_ENDPOINT_READY || forking === p.id}
                          title={
                            FORK_ENDPOINT_READY
                              ? "copy this page into .modus/pages for editing"
                              : "fork endpoint pending — not yet implemented"
                          }
                        >
                          {forking === p.id ? "forking..." : "fork"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function countLayoutWidgets(page: ApiPage): number {
  if (Array.isArray(page.blocks)) return page.blocks.length;
  if (page.layout) return countInLayoutNode(page.layout);
  return 0;
}

function countInLayoutNode(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const n = node as Record<string, unknown>;
  if (n.kind === "widget") return 1;
  const children = n.children;
  if (Array.isArray(children)) {
    return children.reduce<number>((sum, child) => sum + countInLayoutNode(child), 0);
  }
  return 0;
}
