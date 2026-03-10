/**
 * Prompt Loader — scans, compiles, and renders dynamic prompt templates.
 *
 * Prompts are composable templates that gather context via Handlebars helpers
 * (primitives), wrap user input, and can override session settings.
 *
 * Each prompt is a directory: prompts/<name>/ containing:
 *   - prompt.json  → PromptConfig (label, inputs, settings)
 *   - prompt.hbs   → Handlebars template
 *   - context.ts   → Optional custom gather (like action context.ts)
 *
 * Prompts are loaded from:
 *   1. harness/prompts/         → built-in defaults
 *   2. .modus/prompts/          → per-project, from all registered projects
 *
 * Async primitives (read, run, git) are pre-resolved before Handlebars renders.
 * The template source is scanned for helper calls, executed in parallel, and
 * results injected as sync lookups. This keeps Handlebars synchronous while
 * supporting I/O-heavy helpers.
 */

import Handlebars from "handlebars";
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { join, resolve, isAbsolute } from "path";
import { getAllUserProfiles } from "./profiles";

// ── Types ──

export interface PromptInput {
  name: string;
  type?: "text" | "toggle" | "select";
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
  templateSrc: string;         // raw template source (for async helper scanning)
  template: HandlebarsTemplateDelegate;
  source: string;              // "built-in" or project path
  projectCwd?: string;
  hasContext: boolean;
  contextPath?: string;
}

export interface PromptRenderVars {
  input?: string;
  project?: {
    name?: string;
    slug?: string;
    id?: string;
    paths?: string[];
  };
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
const READ_MAX_BYTES = 50_000;  // ~50KB per file read

// ── State ──

const loadedPrompts = new Map<string, LoadedPrompt>();

// ── Async helper pre-resolution cache (populated before each render) ──

let _resolved: Map<string, string> = new Map();

// ── Helpers Registry ──

function registerHelpers(): void {
  // ── Sync helpers ──

  Handlebars.registerHelper("date", (fmt?: string) => {
    const now = new Date();
    if (typeof fmt !== "string") return now.toISOString().split("T")[0];
    return fmt
      .replace("YYYY", String(now.getFullYear()))
      .replace("MM", String(now.getMonth() + 1).padStart(2, "0"))
      .replace("DD", String(now.getDate()).padStart(2, "0"))
      .replace("HH", String(now.getHours()).padStart(2, "0"))
      .replace("mm", String(now.getMinutes()).padStart(2, "0"))
      .replace("ss", String(now.getSeconds()).padStart(2, "0"));
  });

  Handlebars.registerHelper("env", (name: string) => {
    if (typeof name !== "string") return "";
    const blocked = /secret|token|key|password|pin|auth/i;
    if (blocked.test(name)) return "[redacted]";
    return process.env[name] ?? "";
  });

  // ── Equality block helper: {{#ifCond var "value"}}...{{/ifCond}} ──

  Handlebars.registerHelper("ifCond", function (this: unknown, a: unknown, b: unknown, options: Handlebars.HelperOptions) {
    return a === b ? options.fn(this) : (options.inverse ? options.inverse(this) : "");
  });

  // ── Async helpers (lookup from pre-resolved cache) ──

  Handlebars.registerHelper("read", (...args: unknown[]) => {
    const path = typeof args[0] === "string" ? args[0] : "";
    return _resolved.get(`read:${path}`) ?? `[read: ${path} not resolved]`;
  });

  Handlebars.registerHelper("run", (...args: unknown[]) => {
    const cmd = typeof args[0] === "string" ? args[0] : "";
    return _resolved.get(`run:${cmd}`) ?? `[run: ${cmd} not resolved]`;
  });

  Handlebars.registerHelper("git", (...args: unknown[]) => {
    // Collect all string args before the Handlebars options hash
    const parts: string[] = [];
    for (const a of args) {
      if (typeof a === "string") parts.push(a);
      else break;
    }
    const key = `git:${parts.join(" ")}`;
    return _resolved.get(key) ?? `[git: ${parts.join(" ")} not resolved]`;
  });
}

// ── Async helper resolution ──

function resolvePath(path: string, cwd: string): string {
  const full = isAbsolute(path) ? path : resolve(cwd, path);
  // Basic traversal guard: resolved path must start with cwd
  if (!full.startsWith(resolve(cwd))) return "";
  return full;
}

async function resolveRead(path: string, cwd: string): Promise<string> {
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

async function resolveRun(cmd: string, cwd: string): Promise<string> {
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

async function resolveGit(args: string, cwd: string): Promise<string> {
  return resolveRun(`git ${args}`, cwd);
}

/**
 * Scan template source for async helper calls, execute them all in parallel,
 * and populate the _resolved cache before Handlebars renders.
 */
async function preResolveAsyncHelpers(templateSrc: string, cwd: string): Promise<void> {
  _resolved = new Map();
  const tasks: Array<{ key: string; promise: Promise<string> }> = [];

  // {{read "path"}} — single or double quoted
  for (const m of templateSrc.matchAll(/\{\{read\s+["']([^"']+)["']\}\}/g)) {
    const path = m[1]!;
    const key = `read:${path}`;
    if (!tasks.some(t => t.key === key)) {
      tasks.push({ key, promise: resolveRead(path, cwd) });
    }
  }

  // {{run "cmd"}} — single or double quoted
  for (const m of templateSrc.matchAll(/\{\{run\s+["']([^"']+)["']\}\}/g)) {
    const cmd = m[1]!;
    const key = `run:${cmd}`;
    if (!tasks.some(t => t.key === key)) {
      tasks.push({ key, promise: resolveRun(cmd, cwd) });
    }
  }

  // {{git "arg1" "arg2" ...}} — collect all quoted args
  for (const m of templateSrc.matchAll(/\{\{git\s+((?:["'][^"']*["']\s*)+)\}\}/g)) {
    const rawArgs = m[1]!;
    const parts = [...rawArgs.matchAll(/["']([^"']*?)["']/g)].map(x => x[1]!);
    const key = `git:${parts.join(" ")}`;
    if (!tasks.some(t => t.key === key)) {
      tasks.push({ key, promise: resolveGit(parts.join(" "), cwd) });
    }
  }

  if (tasks.length === 0) return;

  const results = await Promise.allSettled(tasks.map(t => t.promise));
  for (let i = 0; i < tasks.length; i++) {
    const r = results[i]!;
    _resolved.set(tasks[i]!.key, r.status === "fulfilled" ? r.value : `[error: ${r.reason}]`);
  }
}

// ── Loading ──

function loadPromptsFromDir(promptsDir: string, source: string, projectCwd?: string): void {
  if (!existsSync(promptsDir)) return;

  const dirs = readdirSync(promptsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const name of dirs) {
    const dir = join(promptsDir, name);
    const configPath = join(dir, "prompt.json");
    const templatePath = join(dir, "prompt.hbs");

    if (!existsSync(configPath) || !existsSync(templatePath)) {
      console.warn(`[prompts] Skipping "${name}" — missing prompt.json or prompt.hbs`);
      continue;
    }

    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as PromptConfig;
      const templateSrc = readFileSync(templatePath, "utf-8");
      const template = Handlebars.compile(templateSrc, { noEscape: true });
      const contextPath = join(dir, "context.ts");
      const hasContext = existsSync(contextPath);

      const key = projectCwd ? `${name}@${projectCwd}` : name;
      loadedPrompts.set(key, {
        name,
        config,
        templateSrc,
        template,
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

// ── Public API ──

export function loadPrompts(): void {
  loadedPrompts.clear();
  registerHelpers();
  loadPromptsFromDir(BUILT_IN_DIR, "built-in");
  for (const { promptsDir, projectCwd } of discoverProjectPromptDirs()) {
    loadPromptsFromDir(promptsDir, projectCwd, projectCwd);
  }
  console.log(`[prompts] ${loadedPrompts.size} prompt(s) loaded`);
}

export function listPrompts(opts?: { tags?: string[]; projectCwd?: string }): PromptListItem[] {
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
  return loadedPrompts.get(name) ?? null;
}

export async function renderPrompt(
  name: string,
  vars: PromptRenderVars,
  projectCwd?: string,
): Promise<{ rendered: string; config: PromptConfig } | { error: string }> {
  const prompt = getPrompt(name, projectCwd);
  if (!prompt) return { error: `prompt "${name}" not found` };

  try {
    // Determine CWD for async helpers
    const cwd = prompt.projectCwd
      ?? projectCwd
      ?? (vars.project?.paths as string[] | undefined)?.[0]
      ?? process.cwd();

    // If context.ts exists, run its gather() and merge output
    if (prompt.hasContext && prompt.contextPath) {
      const mod = await import(prompt.contextPath);
      if (typeof mod.gather === "function") {
        const extra = await mod.gather(vars);
        if (extra && typeof extra === "object") {
          Object.assign(vars, extra);
        }
      }
    }

    // Pre-resolve async helpers (read, run, git)
    await preResolveAsyncHelpers(prompt.templateSrc, cwd);

    const rendered = prompt.template(vars);
    return { rendered, config: prompt.config };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `render failed: ${msg}` };
  }
}

export function reloadPrompts(): void {
  loadPrompts();
}
