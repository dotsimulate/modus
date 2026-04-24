/**
 * Pages browser widget — manages the active user's page nav set.
 *
 * Discovery still comes from /api/pages plus bare move pages. Rendering and
 * enable/pin/order controls are delegated to PagePicker so the top-nav launcher
 * and full manager share the same page preference model.
 */

import { useCallback, useEffect, useState } from "react";
import type { MoveListItem } from "../../../sdk/index";
import { API_BASE, authHeaders, modus } from "../modusClient";
import { useProfiles } from "../providers/ProfileContext";
import type { WidgetProps } from "./types";
import type { View } from "../views";
import { customPageView, movePageView } from "../views";
import { WidgetEmptyState } from "./widget-components";
import { PagePicker } from "../components/PagePicker";
import { usePageNavPrefs } from "../hooks/usePageNavPrefs";
import { countPageWidgets, type PageNavItem, type PageNavOrigin } from "../pageNav";

type ApiPage = {
  id: string;
  title: string;
  blocks?: unknown[];
  layout?: unknown;
  padding?: number;
  source?: string;
  origin?: "standalone" | "harness" | "move" | "action" | "mission";
  nav?: boolean;
};

type Props = WidgetProps & {
  projectCwdOverride?: string;
};

export default function PagesBrowserWidget({ onNavigate, projectCwdOverride }: Props) {
  const { activeUP, activeCwd, projectRoot } = useProfiles();
  const { prefs, canSave, savePrefs } = usePageNavPrefs();
  const cwd = projectCwdOverride ?? projectRoot ?? activeCwd ?? activeUP?.projects?.[0] ?? null;

  const [pages, setPages] = useState<ApiPage[]>([]);
  const [moves, setMoves] = useState<MoveListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forking, setForking] = useState<View | null>(null);
  const [forkMessage, setForkMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!cwd) {
      setPages([]);
      setMoves([]);
      return;
    }
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`${API_BASE}/api/pages?cwd=${encodeURIComponent(cwd)}`, {
        headers: authHeaders(),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`status ${res.status}`);
          return res.json();
        })
        .then((data) => Array.isArray(data) ? data : []),
      modus.listMoves(cwd).catch(() => [] as MoveListItem[]),
    ])
      .then(([pageData, moveData]) => {
        setPages(pageData);
        setMoves(moveData);
      })
      .catch((err) => {
        setError(`failed to load pages: ${err?.message ?? err}`);
        setPages([]);
        setMoves([]);
      })
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => {
    load();
  }, [load]);

  const handleFork = useCallback(
    async (page: PageNavItem) => {
      if (!cwd || !page.key.startsWith("page:")) return;
      const pageId = page.key.slice("page:".length);
      setForking(page.key);
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
  const navItems = buildPageNavItems(pages, moves);
  if (navItems.length === 0) return <WidgetEmptyState>no pages available</WidgetEmptyState>;
  return (
    <div className="pages-browser">
      {forkMessage && <div className="pages-browser-toast">{forkMessage}</div>}
      <PagePicker
        pages={navItems}
        activeView={"page:pages"}
        prefs={prefs}
        canEdit={canSave}
        variant="manager"
        onNavigate={onNavigate}
        onPrefsChange={savePrefs}
        onFork={handleFork}
        forkingKey={forking}
      />
    </div>
  );
}

function buildPageNavItems(pages: ApiPage[], moves: MoveListItem[]): PageNavItem[] {
  const items = pages.map((page): PageNavItem => ({
    key: customPageView(page.id),
    view: customPageView(page.id),
    id: page.id,
    title: page.title,
    label: page.title,
    origin: (page.origin as PageNavOrigin | undefined) ?? "standalone",
    navDefault: page.nav !== false,
    widgetCount: countPageWidgets(page),
    canFork: page.origin !== undefined && page.origin !== "standalone",
  }));
  const pageIds = new Set(pages.map((page) => page.id));
  const bareMovePages = moves
    .filter((move) => move.page && !move.page.layout && !pageIds.has(move.page.id))
    .map((move): PageNavItem => ({
      key: movePageView(move.name),
      view: movePageView(move.name),
      id: move.page!.id,
      title: move.page!.title,
      label: move.page!.title,
      origin: "move",
      navDefault: move.page!.nav !== false,
    }));
  return [...items, ...bareMovePages];
}
