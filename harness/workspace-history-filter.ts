import { relative, sep } from "path";

import type { ShadowScope } from "./workspace-history";

const PROJECT_INCLUDE_DIRS = new Set([
  "pages",
  "moves",
  "actions",
  "profiles",
  "themes",
  "fonts",
  "memory",
]);

const PROJECT_INCLUDE_FILES = new Set([
  "_global.json",
]);

const PROJECT_EXCLUDE_PATTERNS = [
  /^moves-backup-/,
  /^moves-export-/,
  /\.zip$/,
  /^ui\/active\//,
  /^_registry\.json$/,
  /^outputs\//,
  /^gallery\//,
  /^handoffs\//,
  /^state\//,
  /^notes\//,
  /^docs\//,
  /^prompts\//,
  /^rooms\//,
  /^missions\//,
  /^api-handlers\//,
  /\.db$/,
  /\.sqlite$/,
  /\.history\//,
  /\/\.history\//,
  /\/output\//,
  /\/state\//,
];

const USER_INCLUDE_DIRS = new Set([
  "agents",
  "users",
  "ui",
]);

const USER_INCLUDE_FILES = new Set([
  "_global.json",
  "_users.json",
  "prompt-cache.json",
]);

const USER_EXCLUDE_PATTERNS = [
  /^state\//,
  /\.history\//,
  /\/\.history\//,
];

export function isTracked(absPath: string, scope: ShadowScope, workTree: string): boolean {
  const rel = relative(workTree, absPath).split(sep).join("/");
  if (!rel || rel.startsWith("..") || rel.startsWith("/")) return false;

  if (scope.kind === "project") {
    for (const pat of PROJECT_EXCLUDE_PATTERNS) {
      if (pat.test(rel)) return false;
    }
    const topDir = rel.split("/")[0]!;
    if (PROJECT_INCLUDE_DIRS.has(topDir)) return true;
    if (PROJECT_INCLUDE_FILES.has(rel)) return true;
    if (rel.startsWith("ui/profiles/")) return true;
    return false;
  }

  for (const pat of USER_EXCLUDE_PATTERNS) {
    if (pat.test(rel)) return false;
  }
  const topDir = rel.split("/")[0]!;
  if (USER_INCLUDE_DIRS.has(topDir)) return true;
  if (USER_INCLUDE_FILES.has(rel)) return true;
  return false;
}
