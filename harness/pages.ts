import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { APP_PATHS } from "./app-paths";
import {
  getPluginActionsDir,
  getPluginMovesDir,
  getPluginPagesDir,
  listEnabledModusPlugins,
  type ModusPlugin,
} from "./modus-plugins";

export type ConfigPage = {
  id: string;
  title: string;
  blocks?: unknown[];
  layout?: unknown;
  /** Optional breakpoint-specific layout trees */
  layouts?: {
    mobile?: unknown;
  };
  /** Initial page-scoped shared state for widget linking (pub/sub) */
  context?: Record<string, unknown>;
  padding?: number;
  source?: string;
  /** Origin primitive that declared this page */
  origin?: "standalone" | "plugin" | "harness" | "move" | "action" | "mission";
  /** Show in nav bar (default true) */
  nav?: boolean;
  /** Hide app-level panels when this page is active */
  fullscreen?: boolean;
};

type PageFile =
  | ConfigPage
  | { pages: ConfigPage[] };

function isConfigPage(value: unknown): value is ConfigPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Record<string, unknown>;
  return typeof page.id === "string"
    && typeof page.title === "string"
    && (Array.isArray(page.blocks) || (!!page.layout && typeof page.layout === "object"));
}

function normalizePageFile(data: unknown, source: string): ConfigPage[] {
  if (isConfigPage(data)) return [{ ...data, source }];
  if (data && typeof data === "object" && Array.isArray((data as { pages?: unknown[] }).pages)) {
    return (data as { pages: unknown[] }).pages
      .filter(isConfigPage)
      .map((page) => ({ ...page, source }));
  }
  return [];
}

/** Read JSON file safely — returns null on any error */
function readJsonSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Scan a directory of standalone page json files */
function scanPageDir(dir: string, origin: ConfigPage["origin"]): ConfigPage[] {
  if (!existsSync(dir)) return [];

  const pages: ConfigPage[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const fullPath = join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(fullPath, "utf-8")) as PageFile;
      for (const page of normalizePageFile(parsed, fullPath)) {
        pages.push({ ...page, origin });
      }
    } catch (error) {
      console.warn(`[pages] Failed to parse ${fullPath}:`, error);
    }
  }
  return pages;
}

/** Scan project `.modus/pages/*.json` files */
function scanStandalonePages(cwd: string): ConfigPage[] {
  return scanPageDir(join(cwd, ".modus", "pages"), "standalone");
}

/** Scan enabled plugin `.modus/pages/*.json` files */
function scanPluginStandalonePages(): ConfigPage[] {
  return listEnabledModusPlugins().flatMap((plugin) => {
    const visible = new Set(plugin.manifest.integration?.pages ?? []);
    return scanPageDir(getPluginPagesDir(plugin), "plugin")
      .filter((page) => visible.has(page.id))
      .map((page) => plugin.manifest.integration?.pageNav === "hidden"
        ? { ...page, nav: false }
        : page);
  });
}

/** Scan harness-shipped `harness/pages/*.json` built-in templates */
function scanHarnessPages(): ConfigPage[] {
  return scanPageDir(join(APP_PATHS.resourcesDir, "pages"), "harness");
}

/** Page declaration shape embedded in move/action/mission configs */
type EmbeddedPageDecl = {
  id: string;
  title: string;
  icon?: string;
  nav?: boolean;
  layout?: unknown;
  layouts?: {
    mobile?: unknown;
  };
  context?: Record<string, unknown>;
  padding?: number;
};

function isEmbeddedPage(value: unknown): value is EmbeddedPageDecl {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.id === "string"
    && typeof p.title === "string"
    && !!p.layout && typeof p.layout === "object";
}

/** Scan move directories for moves with page.layout declarations */
function scanMovePages(cwd: string): ConfigPage[] {
  const pages: ConfigPage[] = [];
  const dirs: Array<{ dir: string; plugin?: ModusPlugin }> = [
    { dir: join(cwd, ".modus", "moves") },
    ...listEnabledModusPlugins().map((plugin) => ({ dir: getPluginMovesDir(plugin), plugin })),
    { dir: join(APP_PATHS.resourcesDir, "moves") },
  ];

  const seen = new Set<string>(); // deduplicate move names (project overrides harness)

  for (const { dir, plugin } of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        seen.add(entry.name);
        const configPath = join(dir, entry.name, "move.json");
        const data = readJsonSafe(configPath);
        if (!data || typeof data !== "object") continue;
        const move = data as Record<string, unknown>;
        // Skip disabled moves
        if (move.enabled === false) continue;
        const page = move.page;
        if (!isEmbeddedPage(page)) continue;
        if (plugin && !plugin.manifest.integration?.pages?.includes(page.id)) continue;
        pages.push({
          id: page.id,
          title: page.title,
          layout: page.layout,
          context: page.context,
          padding: page.padding,
          nav: plugin?.manifest.integration?.pageNav === "hidden" ? false : page.nav,
          source: configPath,
          origin: "move",
        });
      }
    } catch {
      // directory scan failed
    }
  }
  return pages;
}

/** Scan action directories for actions with page declarations */
function scanActionPages(cwd: string): ConfigPage[] {
  const pages: ConfigPage[] = [];
  const dirs: Array<{ dir: string; plugin?: ModusPlugin }> = [
    { dir: join(cwd, ".modus", "actions") },
    ...listEnabledModusPlugins().map((plugin) => ({ dir: getPluginActionsDir(plugin), plugin })),
    { dir: join(APP_PATHS.resourcesDir, "actions") },
  ];

  const seen = new Set<string>();

  for (const { dir, plugin } of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        seen.add(entry.name);
        const configPath = join(dir, entry.name, "action.json");
        const data = readJsonSafe(configPath);
        if (!data || typeof data !== "object") continue;
        const action = data as Record<string, unknown>;
        if (action.enabled === false) continue;
        const page = action.page;
        if (!isEmbeddedPage(page)) continue;
        if (plugin && !plugin.manifest.integration?.pages?.includes(page.id)) continue;
        pages.push({
          id: page.id,
          title: page.title,
          layout: page.layout,
          context: page.context,
          padding: page.padding,
          nav: plugin?.manifest.integration?.pageNav === "hidden" ? false : page.nav,
          source: configPath,
          origin: "action",
        });
      }
    } catch {
      // directory scan failed
    }
  }
  return pages;
}

/** Scan mission directories for missions with page declarations */
function scanMissionPages(cwd: string): ConfigPage[] {
  const pages: ConfigPage[] = [];
  const dir = join(cwd, ".modus", "missions");
  if (!existsSync(dir)) return [];

  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const configPath = join(dir, entry.name, "mission.json");
      const data = readJsonSafe(configPath);
      if (!data || typeof data !== "object") continue;
      const mission = data as Record<string, unknown>;
      if (mission.enabled === false) continue;
      const page = mission.page;
      if (!isEmbeddedPage(page)) continue;
      pages.push({
        id: page.id,
        title: page.title,
        layout: page.layout,
        context: page.context,
        padding: page.padding,
        source: configPath,
        origin: "mission",
      });
    }
  } catch {
    // directory scan failed
  }
  return pages;
}

/**
 * List all config pages from all sources:
 * 1. Standalone: .modus/pages/*.json (project)
 * 2. Harness:    harness/pages/*.json (built-in templates)
 * 3. Moves:      move.json with page.layout
 * 4. Actions:    action.json with page
 * 5. Missions:   mission.json with page
 *
 * Deduplicates by page id — first occurrence wins.
 * Project standalone pages override harness defaults; to "fork" a built-in,
 * drop a same-id file into `.modus/pages/`.
 */
export function listConfigPages(cwd?: string | null): ConfigPage[] {
  if (!cwd) return [];

  const all = [
    ...scanStandalonePages(cwd),
    ...scanPluginStandalonePages(),
    ...scanHarnessPages(),
    ...scanMovePages(cwd),
    ...scanActionPages(cwd),
    ...scanMissionPages(cwd),
  ];

  const byId = new Map<string, ConfigPage>();
  for (const page of all) {
    const existing = byId.get(page.id);
    if (!existing) {
      byId.set(page.id, page);
      continue;
    }

    if (!existing.layouts && page.layouts) {
      existing.layouts = page.layouts;
    } else if (existing.layouts && page.layouts) {
      existing.layouts = {
        ...page.layouts,
        ...existing.layouts,
      };
    }
  }
  return Array.from(byId.values());
}

/**
 * Fork a page into the project's `.modus/pages/` directory.
 *
 * Resolves the page from non-standalone sources (harness/moves/actions/missions)
 * so we always copy the "original" even if a same-id standalone already exists.
 * Strips `origin` and `source` metadata before writing.
 */
export function forkConfigPage(
  cwd: string,
  pageId: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (!cwd) return { ok: false, error: "cwd is required" };
  if (!pageId || typeof pageId !== "string") return { ok: false, error: "pageId is required" };

  const sources: ConfigPage[] = [
    ...scanHarnessPages(),
    ...scanMovePages(cwd),
    ...scanActionPages(cwd),
    ...scanMissionPages(cwd),
  ];

  const source = sources.find((p) => p.id === pageId);
  if (!source) return { ok: false, error: `page "${pageId}" not found in forkable sources` };

  const { origin: _origin, source: _source, ...page } = source;
  const targetDir = join(cwd, ".modus", "pages");
  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, `${pageId}.json`);
  writeFileSync(targetPath, `${JSON.stringify(page, null, 2)}\n`, "utf-8");
  return { ok: true, path: targetPath };
}
