import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export type ConfigPage = {
  id: string;
  title: string;
  blocks?: unknown[];
  layout?: unknown;
  /** Initial page-scoped shared state for widget linking (pub/sub) */
  context?: Record<string, unknown>;
  padding?: number;
  source?: string;
  /** Origin primitive that declared this page */
  origin?: "standalone" | "move" | "action" | "mission";
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

/** Scan standalone .modus/pages/*.json files */
function scanStandalonePages(cwd: string): ConfigPage[] {
  const dir = join(cwd, ".modus", "pages");
  if (!existsSync(dir)) return [];

  const pages: ConfigPage[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const fullPath = join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(fullPath, "utf-8")) as PageFile;
      for (const page of normalizePageFile(parsed, fullPath)) {
        pages.push({ ...page, origin: "standalone" });
      }
    } catch (error) {
      console.warn(`[pages] Failed to parse ${fullPath}:`, error);
    }
  }
  return pages;
}

/** Page declaration shape embedded in move/action/mission configs */
type EmbeddedPageDecl = {
  id: string;
  title: string;
  icon?: string;
  nav?: boolean;
  layout?: unknown;
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
  const dirs = [
    { dir: join(cwd, ".modus", "moves"), label: "project" },
    { dir: join(import.meta.dir, "moves"), label: "harness" },
  ];

  const seen = new Set<string>(); // deduplicate move names (project overrides harness)

  for (const { dir, label } of dirs) {
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
        pages.push({
          id: page.id,
          title: page.title,
          layout: page.layout,
          context: page.context,
          padding: page.padding,
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
  const dirs = [
    join(cwd, ".modus", "actions"),
    join(import.meta.dir, "actions"),
  ];

  const seen = new Set<string>();

  for (const dir of dirs) {
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
        pages.push({
          id: page.id,
          title: page.title,
          layout: page.layout,
          context: page.context,
          padding: page.padding,
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
 * 1. Standalone: .modus/pages/*.json
 * 2. Moves: move.json with page.layout
 * 3. Actions: action.json with page
 * 4. Missions: mission.json with page
 *
 * Deduplicates by page id — first occurrence wins.
 * Standalone pages take precedence (scanned first).
 */
export function listConfigPages(cwd?: string | null): ConfigPage[] {
  if (!cwd) return [];

  const all = [
    ...scanStandalonePages(cwd),
    ...scanMovePages(cwd),
    ...scanActionPages(cwd),
    ...scanMissionPages(cwd),
  ];

  const seen = new Set<string>();
  return all.filter((page) => {
    if (seen.has(page.id)) return false;
    seen.add(page.id);
    return true;
  });
}
