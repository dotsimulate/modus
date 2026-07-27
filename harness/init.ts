/**
 * Project init — scaffolds .modus/ directory structure in a target CWD.
 *
 * Creates:
 *   .modus/
 *     _project.json        — project ID (portable, travels with the folder)
 *     _global.json          — project-level MCP servers
 *     profiles/agents/      — project-specific agent profiles
 *     actions/              — project-specific automation
 *     moves/ pages/ ui/extensions/ — project-authored merge surfaces
 *     memory/               — project-scoped memory files
 *
 * Registers the project in the harness-level _projects.json registry.
 * Idempotent — won't overwrite existing files, only creates missing structure.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, resolve, basename } from "path";
import { registerProject, getProjectByPath, getProjectById, updateProjectPath } from "./profiles";

const MODUS_DIR = ".modus";

type ProjectMeta = { id: string; name?: string; created?: string };

function readProjectMeta(cwd: string): ProjectMeta | undefined {
  const metaPath = join(cwd, MODUS_DIR, "_project.json");
  if (!existsSync(metaPath)) return undefined;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8")) as ProjectMeta;
  } catch {
    return undefined;
  }
}

function generateProjectId(): string {
  const rand = crypto.randomUUID().split("-")[0];
  return `proj-${rand}`;
}

function writeJson(filePath: string, data: unknown): void {
  Bun.write(filePath, JSON.stringify(data, null, 2) + "\n");
}

export type InitResult = {
  ok: true;
  projectId: string;
  created: string[];
  skipped: string[];
  alreadyInitialized: boolean;
} | {
  ok: false;
  error: string;
};

/**
 * Initialize .modus/ structure in a target directory.
 * Idempotent: skips files/dirs that already exist.
 */
export function initProject(cwd: string, opts?: { name?: string }): InitResult {
  const target = resolve(cwd);
  if (!existsSync(target)) {
    return { ok: false, error: `target directory does not exist: ${target}` };
  }

  const modusDir = join(target, MODUS_DIR);
  const created: string[] = [];
  const skipped: string[] = [];

  // Check if already initialized
  const existingMeta = readProjectMeta(target);
  const alreadyInitialized = !!existingMeta;

  // Create directory structure
  const dirs = [
    modusDir,
    join(modusDir, "profiles", "agents"),
    join(modusDir, "actions"),
    join(modusDir, "moves"),
    join(modusDir, "pages"),
    join(modusDir, "ui", "extensions"),
    join(modusDir, "prompts"),
    join(modusDir, "missions"),
    join(modusDir, "memory"),
  ];

  for (const dir of dirs) {
    if (existsSync(dir)) {
      skipped.push(dir);
    } else {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }

  // Write _project.json (only if missing)
  const metaPath = join(modusDir, "_project.json");
  let projectId: string;
  if (existingMeta) {
    projectId = existingMeta.id;
    skipped.push(metaPath);
  } else {
    projectId = generateProjectId();
    const projectName = opts?.name ?? basename(target);
    writeJson(metaPath, {
      id: projectId,
      name: projectName,
      created: new Date().toISOString(),
    });
    created.push(metaPath);
  }

  // Write _global.json (only if missing)
  const globalPath = join(modusDir, "_global.json");
  if (existsSync(globalPath)) {
    skipped.push(globalPath);
  } else {
    writeJson(globalPath, {
      mcpServers: {},
      notificationChannels: {},
    });
    created.push(globalPath);
  }

  // Register in harness project registry
  // If already registered by path, update; if by ID, update path; otherwise create
  const existingByPath = getProjectByPath(target);
  const existingById = getProjectById(projectId);

  if (!existingByPath && !existingById) {
    registerProject(projectId, {
      name: existingMeta?.name ?? opts?.name ?? basename(target),
      path: target,
      created: existingMeta?.created ?? new Date().toISOString(),
    });
  } else if (existingById && existingById.path !== target) {
    // Project moved — update path in registry
    updateProjectPath(projectId, target);
  }

  return { ok: true, projectId, created, skipped, alreadyInitialized };
}

/**
 * Check init status for a directory.
 */
export function getInitStatus(cwd: string): {
  initialized: boolean;
  projectId: string | null;
  registered: boolean;
  meta: ProjectMeta | null;
  pathMatch: boolean;
} {
  const target = resolve(cwd);
  const meta = readProjectMeta(target);

  if (!meta) {
    return { initialized: false, projectId: null, registered: false, meta: null, pathMatch: false };
  }

  const registered = getProjectById(meta.id);
  return {
    initialized: true,
    projectId: meta.id,
    registered: !!registered,
    meta,
    pathMatch: registered?.path === target,
  };
}
