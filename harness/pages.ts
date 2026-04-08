import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export type ConfigPage = {
  id: string;
  title: string;
  blocks?: unknown[];
  layout?: unknown;
  padding?: number;
  source?: string;
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

export function listConfigPages(cwd?: string | null): ConfigPage[] {
  if (!cwd) return [];
  const dir = join(cwd, ".modus", "pages");
  if (!existsSync(dir)) return [];

  const pages: ConfigPage[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const fullPath = join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(fullPath, "utf-8")) as PageFile;
      pages.push(...normalizePageFile(parsed, fullPath));
    } catch (error) {
      console.warn(`[pages] Failed to parse ${fullPath}:`, error);
    }
  }

  const seen = new Set<string>();
  return pages.filter((page) => {
    if (seen.has(page.id)) return false;
    seen.add(page.id);
    return true;
  });
}
