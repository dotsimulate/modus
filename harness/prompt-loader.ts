/**
 * Prompt Loader — scans, loads, and renders dynamic prompts.
 *
 * Prompts are composable templates that gather context via TypeScript,
 * wrap user input, and can override session settings.
 *
 * Each prompt is a directory: prompts/<name>/ containing:
 *   - prompt.json  → PromptConfig (label, inputs, settings)
 *   - context.ts   → gather(ctx: PromptGatherContext) => string
 *
 * Prompts are loaded from:
 *   1. harness/prompts/         → built-in defaults
 *   2. .modus/prompts/          → per-project, from all registered projects
 *
 * The gather() function receives a PromptGatherContext with I/O helpers
 * (read, run, git) and returns the prompt string directly. No Handlebars.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { join, resolve, isAbsolute } from "path";
import { getAllUserProfiles } from "./profiles";
import type { PromptGatherContext } from "./gather-types";

// ── Types ──

export interface PromptInput {
  name: string;
  type?: "text" | "toggle" | "select" | "textarea";
  label?: string;
  placeholder?: string;
  required?: boolean;
  default?: string;
  options?: string[];
}

export interface PromptConfig {
  label: string;
  description?: string;
  profile?: string;
  icon?: string;
  inputs?: PromptInput[];
  settings?: {
    provider?: string;
    model?: string;
    effort?: string;
    cwd?: string;
  };
  tags?: string[];
}

export interface LoadedPrompt {
  name: string;
  config: PromptConfig;
  source: string;              // "built-in" or project path
  projectCwd?: string;
  hasContext: boolean;
  contextPath?: string;
}

export interface PromptRenderVars {
  inputs: Record<string, unknown>;
  project?: {
    name?: string;
    slug?: string;
    id?: string;
    paths?: string[];
    cwd?: string;
  };
  session?: {
    id: string;
    profile?: string;
    exchangeCount: number;
  };
  projectCwd?: string;
  [key: string]: unknown;
}

export interface PromptListItem {
  name: string;
  label: string;
  description?: string;
  icon?: string;
  profile?: string;
  inputs?: PromptInput[];
  settings?: PromptConfig["settings"];
  tags?: string[];
  source: string;
}

// ── Constants ──

const BUILT_IN_DIR = join(import.meta.dir, "prompts");
const MODUS_PROMPTS = ".modus/prompts";
const RUN_TIMEOUT_MS = 10_000;
const READ_MAX_BYTES = 50_000;
const GATHER_TIMEOUT_MS = 10_000;

// ── State ──

const loadedPrompts = new Map<string, LoadedPrompt>();
let _loadFingerprint = "";

// ── I/O Helpers (shared by gather contexts) ──

function resolvePath(path: string, cwd: string): string {
  const full = isAbsolute(path) ? path : resolve(cwd, path);
  if (!full.startsWith(resolve(cwd))) return "";
  return full;
}

async function helperRead(path: string, cwd: string): Promise<string> {
  const full = resolvePath(path, cwd);
  if (!full) return `[read error: path traversal blocked]`;
  try {
    if (!existsSync(full)) return `[read: ${path} not found]`;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      const entries = await readdir(full);
      return entries.join("\n");
    }
    if (stat.size > READ_MAX_BYTES) {
      const content = await readFile(full, "utf-8");
      return content.slice(0, READ_MAX_BYTES) + `\n[truncated at ${READ_MAX_BYTES} bytes]`;
    }
    return await readFile(full, "utf-8");
  } catch (err) {
    return `[read error: ${err instanceof Error ? err.message : err}]`;
  }
}

async function helperRun(cmd: string, cwd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["sh", "-c", cmd], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const timeout = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    clearTimeout(timeout);
    const output = stdout.trim();
    if (!output && stderr.trim()) return stderr.trim();
    return output;
  } catch (err) {
    return `[run error: ${err instanceof Error ? err.message : err}]`;
  }
}

async function helperGit(args: string[], cwd: string): Promise<string> {
  return helperRun(`git ${args.join(" ")}`, cwd);
}

/** Build a PromptGatherContext for a given prompt render. */
export function buildPromptGatherContext(
  vars: PromptRenderVars,
  cwd: string,
): PromptGatherContext {
  const metadata: Record<string, unknown> = {};

  return {
    inputs: vars.inputs ?? {},
    project: {
      name: vars.project?.name ?? "",
      slug: vars.project?.slug ?? "",
      id: vars.project?.id,
      paths: (vars.project?.paths as string[]) ?? [],
      cwd: vars.project?.cwd ?? cwd,
    },
    cwd,
    date: new Date().toISOString().split("T")[0]!,
    session: vars.session,

    read: (path: string) => helperRead(path, cwd),
    run: (cmd: string) => helperRun(cmd, cwd),
    git: (...args: string[]) => helperGit(args, cwd),
    meta: (key: string, value: unknown) => { metadata[key] = value; },
  };
}

// ── Loading ──

function loadPromptsFromDir(promptsDir: string, source: string, projectCwd?: string): void {
  if (!existsSync(promptsDir)) return;

  const dirs = readdirSync(promptsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith("_"))
    .map(d => d.name);

  for (const name of dirs) {
    const dir = join(promptsDir, name);
    const configPath = join(dir, "prompt.json");

    if (!existsSync(configPath)) {
      console.warn(`[prompts] Skipping "${name}" — missing prompt.json`);
      continue;
    }

    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as PromptConfig;
      const contextPath = join(dir, "context.ts");
      const hasContext = existsSync(contextPath);

      const key = projectCwd ? `${name}@${projectCwd}` : name;
      loadedPrompts.set(key, {
        name,
        config,
        source,
        projectCwd,
        hasContext,
        contextPath: hasContext ? contextPath : undefined,
      });

      console.log(`[prompts] Loaded "${name}" from ${source}`);
    } catch (err) {
      console.error(`[prompts] Failed to load "${name}":`, err);
    }
  }
}

function discoverProjectPromptDirs(): Array<{ promptsDir: string; projectCwd: string }> {
  const result: Array<{ promptsDir: string; projectCwd: string }> = [];
  const userProfiles = getAllUserProfiles();
  const seen = new Set<string>();
  for (const up of Object.values(userProfiles)) {
    for (const proj of up.projects ?? []) {
      if (seen.has(proj)) continue;
      seen.add(proj);
      const dir = join(proj, MODUS_PROMPTS);
      if (existsSync(dir)) result.push({ promptsDir: dir, projectCwd: proj });
    }
  }
  return result;
}

// ── Staleness Detection ──

function computePromptFingerprint(): string {
  const parts: string[] = [];
  const scanDir = (dir: string) => {
    if (!existsSync(dir)) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const name of entries) {
        const full = join(dir, name);
        try {
          const mt = statSync(full).mtimeMs;
          parts.push(`${full}:${mt}`);
        } catch {
          parts.push(`${full}:?`);
        }
      }
    } catch { /* dir unreadable */ }
  };

  scanDir(BUILT_IN_DIR);
  for (const { promptsDir } of discoverProjectPromptDirs()) {
    scanDir(promptsDir);
  }
  return parts.sort().join("|");
}

// ── Public API ──

export function loadPrompts(): void {
  loadedPrompts.clear();
  loadPromptsFromDir(BUILT_IN_DIR, "built-in");
  for (const { promptsDir, projectCwd } of discoverProjectPromptDirs()) {
    loadPromptsFromDir(promptsDir, projectCwd, projectCwd);
  }
  _loadFingerprint = computePromptFingerprint();
  console.log(`[prompts] ${loadedPrompts.size} prompt(s) loaded`);
}

export function listPrompts(opts?: { tags?: string[]; projectCwd?: string }): PromptListItem[] {
  const current = computePromptFingerprint();
  if (current !== _loadFingerprint) {
    console.log("[prompts] Prompt directories changed, reloading...");
    loadPrompts();
  }

  const results: PromptListItem[] = [];
  const seen = new Set<string>();

  for (const p of loadedPrompts.values()) {
    if (opts?.projectCwd && p.projectCwd && p.projectCwd !== opts.projectCwd) continue;
    if (opts?.tags?.length) {
      const promptTags = p.config.tags ?? [];
      if (!opts.tags.some(t => promptTags.includes(t))) continue;
    }
    if (seen.has(p.name)) continue;
    seen.add(p.name);

    results.push({
      name: p.name,
      label: p.config.label,
      description: p.config.description,
      icon: p.config.icon,
      profile: p.config.profile,
      inputs: p.config.inputs,
      settings: p.config.settings,
      tags: p.config.tags,
      source: p.source,
    });
  }
  return results;
}

export function getPrompt(name: string, projectCwd?: string): LoadedPrompt | null {
  if (projectCwd) {
    const projectKey = `${name}@${projectCwd}`;
    if (loadedPrompts.has(projectKey)) return loadedPrompts.get(projectKey)!;
  }
  if (loadedPrompts.has(name)) return loadedPrompts.get(name)!;
  for (const p of loadedPrompts.values()) {
    if (p.name === name) return p;
  }
  return null;
}

export async function renderPrompt(
  name: string,
  vars: PromptRenderVars,
  projectCwd?: string,
): Promise<{ rendered: string; config: PromptConfig } | { error: string }> {
  const prompt = getPrompt(name, projectCwd);
  if (!prompt) return { error: `prompt "${name}" not found` };

  const cwd = prompt.projectCwd
    ?? projectCwd
    ?? (vars.project?.paths as string[] | undefined)?.[0]
    ?? process.cwd();

  try {
    if (!prompt.hasContext || !prompt.contextPath) {
      // No context.ts — just pass through inputs.text as the prompt
      const text = vars.inputs?.text;
      const rendered = typeof text === "string" && text.trim()
        ? text.trim()
        : `(No prompt content — ${prompt.config.label})`;
      return { rendered, config: prompt.config };
    }

    // Build context and call gather()
    const ctx = buildPromptGatherContext(vars, cwd);
    const mod = await import(prompt.contextPath);

    if (typeof mod.gather !== "function") {
      return { error: `prompt "${name}" context.ts missing gather() function` };
    }

    // Execute gather with timeout
    const result = await Promise.race([
      mod.gather(ctx),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("gather() timed out")), GATHER_TIMEOUT_MS)
      ),
    ]);

    // Coerce to string
    const rendered = typeof result === "string"
      ? result
      : Array.isArray(result)
        ? result.map((b: any) => typeof b === "string" ? b : b.text ?? "").join("\n")
        : String(result);

    return { rendered, config: prompt.config };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `render failed: ${msg}` };
  }
}

export function reloadPrompts(): void {
  loadPrompts();
}
