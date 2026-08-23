/**
 * Resource-tree integrity check.
 *
 * Everything the harness ships as data — built-in moves, pages, actions, prompts,
 * docs, first-boot templates — is read lazily from `APP_PATHS.resourcesDir`.
 * Nothing reads it at startup, so a truncated tree does not crash the backend:
 * it boots, serves, and quietly behaves as though the product has no built-ins.
 * The visible symptom lands somewhere else entirely — an attached move reporting
 * `was not found in this project`, which accuses the user's project rather than
 * the install it actually came from.
 *
 * That state is reachable in development. Staging clears `target/<profile>/modus`
 * before Tauri re-populates it (`desktop/stage-managed-backend.ts`), and on
 * Windows a recursive delete that meets a native addon the running backend has
 * mapped throws EPERM and stops mid-directory — leaving every entry sorted after
 * it in place and everything before it gone. Observed 2026-08-22: a dev instance
 * ran roughly seven hours with no `moves/` and no `pages/`, so no built-in move
 * resolved and the chat page vanished, taking the mobile chat layout with it.
 *
 * This module names that condition at startup rather than letting it resurface
 * later wearing someone else's clothes.
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Directories `desktop/stage-managed-backend.ts` copies into a packaged tree and
 * that a source checkout also carries.
 *
 * `ui/dist` is deliberately excluded: it is a build output, and browser
 * development serves the UI from Vite without ever producing it, so requiring it
 * would fire on a healthy fresh clone.
 */
export const REQUIRED_RESOURCE_DIRS = [
  "actions",
  "docs",
  "moves",
  "pages",
  "prompts",
  "templates",
  "ui/extensions",
  "ui/themes",
] as const;

export interface ResourceTreeReport {
  resourcesDir: string;
  /** Required directories that are absent or unreadable. */
  missing: string[];
  /** Required directories that exist but hold nothing. */
  empty: string[];
  ok: boolean;
}

/** Inspect a resource tree. Reads directory entries only — never their contents. */
export function checkResourceTree(resourcesDir: string): ResourceTreeReport {
  const missing: string[] = [];
  const empty: string[] = [];

  for (const relative of REQUIRED_RESOURCE_DIRS) {
    const dir = join(resourcesDir, relative);
    if (!existsSync(dir)) {
      missing.push(relative);
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // Unreadable is indistinguishable from absent for every consumer of this
      // tree, so report it the same way rather than inventing a third state.
      missing.push(relative);
      continue;
    }
    if (entries.length === 0) empty.push(relative);
  }

  return {
    resourcesDir,
    missing,
    empty,
    ok: missing.length === 0 && empty.length === 0,
  };
}

/**
 * Render a report for the backend log, or null when the tree is intact.
 *
 * States the consequence, not just the fact: the operator needs to connect this
 * line to the failure they will otherwise go hunting for in their own project.
 */
export function formatResourceTreeReport(report: ResourceTreeReport): string | null {
  if (report.ok) return null;

  const lines = [`[resources] Incomplete resource tree at ${report.resourcesDir}`];
  if (report.missing.length) lines.push(`[resources]   missing: ${report.missing.join(", ")}`);
  if (report.empty.length) lines.push(`[resources]   empty:   ${report.empty.join(", ")}`);
  lines.push(
    "[resources] Built-in moves, pages, actions, and prompts load lazily from here, so",
    '[resources] the backend runs but reports them as absent — an attached move will say',
    '[resources] "was not found in this project" even though the project is fine.',
    "[resources] In development, re-run staging (`modus dev`) to rebuild this tree.",
  );
  return lines.join("\n");
}
