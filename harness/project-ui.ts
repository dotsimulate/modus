import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { extname, join, resolve } from "path";

const MODUS_UI_DIR = ".modus/ui";
const BUILTIN_THEME_SOURCE = "builtin:harness";
const BUILTIN_MODUS_DARK_FILE = "ui/themes/modus-dark.css";
const BUILTIN_MODUS_LIGHT_FILE = "ui/themes/modus-light.css";
const BUILTIN_MODUS_GRAPHITE_FILE = "ui/themes/modus-graphite.css";
const THEMES_DIR = "themes";
const FONTS_DIR = "fonts";
const ACTIVE_DIR = "active";
const ACTIVE_THEME_FILE = "active/theme.css";
const ACTIVE_FONT_FILE = "active/font.css";
const THEME_REGISTRY_FILE = "theme-registry.json";
const FONT_REGISTRY_FILE = "font-registry.json";

type UiAssetRecord = {
  id: string;
  label: string;
  file: string;
  createdAt: string;
  archived: boolean;
  source?: string;
  notes?: string;
  updatedAt?: string;
};

export type ThemeRecord = UiAssetRecord;
export type FontRecord = UiAssetRecord;

export type ThemeRegistry = {
  version: number;
  activeThemeId?: string;
  activeThemeFile?: string;
  themes: ThemeRecord[];
};

export type FontRegistry = {
  version: number;
  activeFontId?: string;
  activeFontFile?: string;
  fonts: FontRecord[];
};

export type ThemeInfo = ThemeRecord & {
  active: boolean;
  absolutePath: string;
};

export type FontInfo = FontRecord & {
  active: boolean;
  absolutePath: string;
};

export type ActiveCssAsset = {
  id: string;
  label: string;
  file: string;
  activeFile: string;
  css: string;
  variables: Record<string, string>;
};

const BUILTIN_THEMES: ThemeRecord[] = [
  {
    id: "modus-dark",
    label: "Modus Dark",
    file: BUILTIN_MODUS_DARK_FILE,
    createdAt: "2026-03-12T00:00:00.000Z",
    archived: false,
    source: BUILTIN_THEME_SOURCE,
    notes: "Harness default dark theme.",
  },
  {
    id: "modus-light",
    label: "Modus Light",
    file: BUILTIN_MODUS_LIGHT_FILE,
    createdAt: "2026-07-16T00:00:00.000Z",
    archived: false,
    source: BUILTIN_THEME_SOURCE,
    notes: "Warm, low-glare light theme.",
  },
  {
    id: "modus-graphite",
    label: "Modus Graphite",
    file: BUILTIN_MODUS_GRAPHITE_FILE,
    createdAt: "2026-07-16T00:00:00.000Z",
    archived: false,
    source: BUILTIN_THEME_SOURCE,
    notes: "Soft charcoal dark theme with cooler contrast.",
  },
];

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePath(path: string): string {
  return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
}

function isWithinDir(root: string, target: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedTarget = normalizePath(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function uiDir(cwd: string): string {
  return join(cwd, MODUS_UI_DIR);
}

function themeRegistryPath(cwd: string): string {
  return join(uiDir(cwd), THEME_REGISTRY_FILE);
}

function fontRegistryPath(cwd: string): string {
  return join(uiDir(cwd), FONT_REGISTRY_FILE);
}

function themeFilePath(cwd: string, rel: string): string {
  return join(uiDir(cwd), rel);
}

function builtinThemeFilePath(rel: string): string {
  return join(import.meta.dir, rel);
}

function fontFilePath(cwd: string, rel: string): string {
  return join(uiDir(cwd), rel);
}

function ensureUiDirs(cwd: string): void {
  for (const dir of [
    uiDir(cwd),
    join(uiDir(cwd), THEMES_DIR),
    join(uiDir(cwd), FONTS_DIR),
    join(uiDir(cwd), ACTIVE_DIR),
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

function writeJsonFile(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function defaultThemeRegistry(): ThemeRegistry {
  return {
    version: 1,
    activeThemeFile: ACTIVE_THEME_FILE,
    themes: [],
  };
}

function defaultFontRegistry(): FontRegistry {
  return {
    version: 1,
    activeFontFile: ACTIVE_FONT_FILE,
    fonts: [],
  };
}

function resolveProjectFile(cwd: string, rawPath: string): string {
  const full = resolve(cwd, rawPath);
  if (!isWithinDir(cwd, full)) {
    throw new Error(`path must stay within project cwd: ${rawPath}`);
  }
  return full;
}

function normalizeAssetId(raw: string): string {
  const id = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) throw new Error("id is required");
  return id;
}

function assertCssFile(cwd: string, cssPath: string): string {
  const full = resolveProjectFile(cwd, cssPath);
  if (extname(full).toLowerCase() !== ".css") {
    throw new Error(`cssPath must point to a .css file: ${cssPath}`);
  }
  if (!existsSync(full)) {
    throw new Error(`css file not found: ${cssPath}`);
  }
  return full;
}

function parseCssVariables(css: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const pattern = /(--[A-Za-z0-9-_]+)\s*:\s*([^;]+);/g;
  for (const match of css.matchAll(pattern)) {
    vars[match[1]!] = match[2]!.trim();
  }
  return vars;
}

function validateThemeCss(css: string): Record<string, string> {
  const vars = parseCssVariables(css);
  const required = ["--bg", "--text", "--accent", "--border"];
  const missing = required.filter((name) => !vars[name]);
  if (missing.length > 0) {
    throw new Error(`theme css missing required variables: ${missing.join(", ")}`);
  }
  return vars;
}

function validateFontCss(css: string): Record<string, string> {
  const vars = parseCssVariables(css);
  const required = ["--font-sans", "--font-mono"];
  const missing = required.filter((name) => !vars[name]);
  if (missing.length > 0) {
    throw new Error(`font css missing required variables: ${missing.join(", ")}`);
  }
  return vars;
}

function readThemeRegistry(cwd: string): ThemeRegistry {
  return readJsonFile(themeRegistryPath(cwd), defaultThemeRegistry());
}

function writeThemeRegistry(cwd: string, registry: ThemeRegistry): void {
  ensureUiDirs(cwd);
  writeJsonFile(themeRegistryPath(cwd), registry);
}

function readFontRegistry(cwd: string): FontRegistry {
  return readJsonFile(fontRegistryPath(cwd), defaultFontRegistry());
}

function writeFontRegistry(cwd: string, registry: FontRegistry): void {
  ensureUiDirs(cwd);
  writeJsonFile(fontRegistryPath(cwd), registry);
}

function resolveThemeSourcePath(cwd: string, item: ThemeRecord): string {
  return item.source === BUILTIN_THEME_SOURCE
    ? builtinThemeFilePath(item.file)
    : themeFilePath(cwd, item.file);
}

function mergedThemes(registry: ThemeRegistry): ThemeRecord[] {
  const byId = new Map<string, ThemeRecord>();
  for (const item of BUILTIN_THEMES) byId.set(item.id, item);
  for (const item of registry.themes) byId.set(item.id, item);
  return Array.from(byId.values());
}

function themeInfo(cwd: string, registry: ThemeRegistry, item: ThemeRecord): ThemeInfo {
  return {
    ...item,
    active: registry.activeThemeId === item.id,
    absolutePath: resolveThemeSourcePath(cwd, item),
  };
}

function fontInfo(cwd: string, registry: FontRegistry, item: FontRecord): FontInfo {
  return {
    ...item,
    active: registry.activeFontId === item.id,
    absolutePath: fontFilePath(cwd, item.file),
  };
}

export function listThemes(cwd: string): ThemeInfo[] {
  const registry = readThemeRegistry(cwd);
  return mergedThemes(registry).map((item) => themeInfo(cwd, registry, item));
}

export function listFonts(cwd: string): FontInfo[] {
  const registry = readFontRegistry(cwd);
  return registry.fonts.map((item) => fontInfo(cwd, registry, item));
}

export function getTheme(cwd: string, id: string): ThemeInfo | null {
  const registry = readThemeRegistry(cwd);
  const item = mergedThemes(registry).find((entry) => entry.id === id);
  return item ? themeInfo(cwd, registry, item) : null;
}

export function getFont(cwd: string, id: string): FontInfo | null {
  const registry = readFontRegistry(cwd);
  const item = registry.fonts.find((entry) => entry.id === id);
  return item ? fontInfo(cwd, registry, item) : null;
}

export function getActiveTheme(cwd: string): ActiveCssAsset | null {
  const registry = readThemeRegistry(cwd);
  if (!registry.activeThemeId) return null;
  const item = mergedThemes(registry).find((entry) => entry.id === registry.activeThemeId);
  if (!item) return null;
  const activeFile = registry.activeThemeFile ?? ACTIVE_THEME_FILE;
  const activePath = themeFilePath(cwd, activeFile);
  if (!existsSync(activePath)) return null;
  const css = readFileSync(activePath, "utf-8");
  return {
    id: item.id,
    label: item.label,
    file: item.file,
    activeFile,
    css,
    variables: parseCssVariables(css),
  };
}

export function getActiveFont(cwd: string): ActiveCssAsset | null {
  const registry = readFontRegistry(cwd);
  if (!registry.activeFontId) return null;
  const item = registry.fonts.find((entry) => entry.id === registry.activeFontId);
  if (!item) return null;
  const activeFile = registry.activeFontFile ?? ACTIVE_FONT_FILE;
  const activePath = fontFilePath(cwd, activeFile);
  if (!existsSync(activePath)) return null;
  const css = readFileSync(activePath, "utf-8");
  return {
    id: item.id,
    label: item.label,
    file: item.file,
    activeFile,
    css,
    variables: parseCssVariables(css),
  };
}

export function registerTheme(opts: {
  cwd: string;
  themeId: string;
  themeName?: string;
  cssPath: string;
  activate?: boolean;
  notes?: string;
  source?: string;
}): ThemeInfo {
  ensureUiDirs(opts.cwd);
  const themeId = normalizeAssetId(opts.themeId);
  const sourcePath = assertCssFile(opts.cwd, opts.cssPath);
  const css = readFileSync(sourcePath, "utf-8");
  validateThemeCss(css);

  const registry = readThemeRegistry(opts.cwd);
  const now = nowIso();
  const relFile = `${THEMES_DIR}/${themeId}.css`;
  const destPath = themeFilePath(opts.cwd, relFile);
  if (normalizePath(sourcePath) !== normalizePath(destPath)) {
    copyFileSync(sourcePath, destPath);
  }

  const existing = registry.themes.find((item) => item.id === themeId);
  if (existing) {
    existing.label = opts.themeName?.trim() || existing.label;
    existing.file = relFile;
    existing.archived = false;
    existing.notes = opts.notes ?? existing.notes;
    existing.source = opts.source ?? existing.source ?? "api";
    existing.updatedAt = now;
  } else {
    registry.themes.push({
      id: themeId,
      label: opts.themeName?.trim() || themeId,
      file: relFile,
      createdAt: now,
      archived: false,
      source: opts.source ?? "api",
      ...(opts.notes ? { notes: opts.notes } : {}),
    });
  }

  writeThemeRegistry(opts.cwd, registry);
  if (opts.activate) activateTheme(opts.cwd, themeId);
  const theme = getTheme(opts.cwd, themeId);
  if (!theme) throw new Error(`registered theme not found: ${themeId}`);
  return theme;
}

export function registerFont(opts: {
  cwd: string;
  fontId: string;
  fontName?: string;
  cssPath: string;
  activate?: boolean;
  notes?: string;
  source?: string;
}): FontInfo {
  ensureUiDirs(opts.cwd);
  const fontId = normalizeAssetId(opts.fontId);
  const sourcePath = assertCssFile(opts.cwd, opts.cssPath);
  const css = readFileSync(sourcePath, "utf-8");
  validateFontCss(css);

  const registry = readFontRegistry(opts.cwd);
  const now = nowIso();
  const relFile = `${FONTS_DIR}/${fontId}.css`;
  const destPath = fontFilePath(opts.cwd, relFile);
  if (normalizePath(sourcePath) !== normalizePath(destPath)) {
    copyFileSync(sourcePath, destPath);
  }

  const existing = registry.fonts.find((item) => item.id === fontId);
  if (existing) {
    existing.label = opts.fontName?.trim() || existing.label;
    existing.file = relFile;
    existing.archived = false;
    existing.notes = opts.notes ?? existing.notes;
    existing.source = opts.source ?? existing.source ?? "api";
    existing.updatedAt = now;
  } else {
    registry.fonts.push({
      id: fontId,
      label: opts.fontName?.trim() || fontId,
      file: relFile,
      createdAt: now,
      archived: false,
      source: opts.source ?? "api",
      ...(opts.notes ? { notes: opts.notes } : {}),
    });
  }

  writeFontRegistry(opts.cwd, registry);
  if (opts.activate) activateFont(opts.cwd, fontId);
  const font = getFont(opts.cwd, fontId);
  if (!font) throw new Error(`registered font not found: ${fontId}`);
  return font;
}

export function activateTheme(cwd: string, themeId: string): ActiveCssAsset {
  ensureUiDirs(cwd);
  const registry = readThemeRegistry(cwd);
  const item = mergedThemes(registry).find((entry) => entry.id === themeId);
  if (!item) throw new Error(`theme not found: ${themeId}`);
  const sourcePath = resolveThemeSourcePath(cwd, item);
  if (!existsSync(sourcePath)) throw new Error(`theme file not found: ${item.file}`);
  validateThemeCss(readFileSync(sourcePath, "utf-8"));
  const activeFile = registry.activeThemeFile ?? ACTIVE_THEME_FILE;
  copyFileSync(sourcePath, themeFilePath(cwd, activeFile));
  registry.activeThemeId = themeId;
  writeThemeRegistry(cwd, registry);
  const activeTheme = getActiveTheme(cwd);
  if (!activeTheme) throw new Error(`active theme not found after activation: ${themeId}`);
  return activeTheme;
}

export function activateFont(cwd: string, fontId: string): ActiveCssAsset {
  ensureUiDirs(cwd);
  const registry = readFontRegistry(cwd);
  const item = registry.fonts.find((entry) => entry.id === fontId);
  if (!item) throw new Error(`font not found: ${fontId}`);
  const sourcePath = fontFilePath(cwd, item.file);
  if (!existsSync(sourcePath)) throw new Error(`font file not found: ${item.file}`);
  validateFontCss(readFileSync(sourcePath, "utf-8"));
  const activeFile = registry.activeFontFile ?? ACTIVE_FONT_FILE;
  copyFileSync(sourcePath, fontFilePath(cwd, activeFile));
  registry.activeFontId = fontId;
  writeFontRegistry(cwd, registry);
  const activeFont = getActiveFont(cwd);
  if (!activeFont) throw new Error(`active font not found after activation: ${fontId}`);
  return activeFont;
}

export function patchTheme(cwd: string, id: string, patch: {
  label?: string;
  notes?: string;
  archived?: boolean;
}): ThemeInfo {
  const registry = readThemeRegistry(cwd);
  const item = registry.themes.find((entry) => entry.id === id);
  if (!item) throw new Error(`cannot patch built-in or missing theme: ${id}`);
  if (patch.archived && registry.activeThemeId === id) {
    throw new Error("cannot archive the active theme");
  }
  if (patch.label !== undefined) item.label = patch.label.trim() || item.label;
  if (patch.notes !== undefined) item.notes = patch.notes;
  if (patch.archived !== undefined) item.archived = patch.archived;
  item.updatedAt = nowIso();
  writeThemeRegistry(cwd, registry);
  const theme = getTheme(cwd, id);
  if (!theme) throw new Error(`theme not found after patch: ${id}`);
  return theme;
}

export function patchFont(cwd: string, id: string, patch: {
  label?: string;
  notes?: string;
  archived?: boolean;
}): FontInfo {
  const registry = readFontRegistry(cwd);
  const item = registry.fonts.find((entry) => entry.id === id);
  if (!item) throw new Error(`font not found: ${id}`);
  if (patch.archived && registry.activeFontId === id) {
    throw new Error("cannot archive the active font");
  }
  if (patch.label !== undefined) item.label = patch.label.trim() || item.label;
  if (patch.notes !== undefined) item.notes = patch.notes;
  if (patch.archived !== undefined) item.archived = patch.archived;
  item.updatedAt = nowIso();
  writeFontRegistry(cwd, registry);
  const font = getFont(cwd, id);
  if (!font) throw new Error(`font not found after patch: ${id}`);
  return font;
}

export function getUiState(cwd: string) {
  return {
    themes: listThemes(cwd),
    fonts: listFonts(cwd),
    activeTheme: getActiveTheme(cwd),
    activeFont: getActiveFont(cwd),
  };
}
