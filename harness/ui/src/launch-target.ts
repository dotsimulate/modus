/**
 * Resolving a launch target — which project, which folder, what draft.
 *
 * A cross-project launcher has to answer "where does this session live" from a
 * bare cwd, because that is the half the user cannot supply and the half a
 * search hit does not carry. The rules here mirror `isWithinProjectRoot` and
 * `resolveSessionProject` in `harness/session-projects.ts`; they are duplicated
 * client-side rather than fetched because the grounded search pass must render
 * before any round trip, and drift between the two is what this module's tests
 * exist to catch.
 *
 * Pure by design: no React, no fetch, no DOM. See widgets/README.md — UI tests
 * in this repo are pure-logic `bun:test`, so anything worth pinning lives
 * outside the component.
 */

/** The subset of a user profile a launch decision needs. */
export type ProjectLike = {
  name: string;
  displayName?: string;
  projects?: string[];
};

/**
 * Comparison form only. Windows paths are case-insensitive and both separators
 * appear in real config, so a literal string compare would miss matches that
 * the backend makes. Returned paths always keep their configured spelling.
 */
export function normalizeRoot(value: string): string {
  const slashed = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:(?:\/|$)/.test(slashed) ? slashed.toLowerCase() : slashed;
}

export function isWithinRoot(cwd: string, root: string): boolean {
  const candidate = normalizeRoot(cwd);
  const boundary = normalizeRoot(root);
  if (!candidate || !boundary) return false;
  return candidate === boundary || candidate.startsWith(`${boundary}/`);
}

/**
 * The project owning `cwd`. Most-specific root wins, so a project nested inside
 * another one claims its own sessions rather than losing them to the parent.
 */
export function projectForCwd<T extends ProjectLike>(
  cwd: string | null | undefined,
  projects: readonly T[],
): T | null {
  if (!cwd) return null;
  let best: { project: T; length: number } | null = null;
  for (const project of projects) {
    for (const root of project.projects ?? []) {
      if (!root || !isWithinRoot(cwd, root)) continue;
      const length = normalizeRoot(root).length;
      if (!best || length > best.length) best = { project, length };
    }
  }
  return best?.project ?? null;
}

/** Display label for a resolved project, falling back to its id then to a marker. */
export function projectLabel(project: ProjectLike | null | undefined): string {
  if (!project) return "unconfigured";
  return project.displayName?.trim() || project.name;
}

/**
 * The folder to open in: the project's longest configured root containing
 * `cwd`, else its first root. Never invents a path — a project with no
 * configured folder returns undefined so the caller can fall back.
 */
export function rootFor(project: ProjectLike | null | undefined, cwd?: string | null): string | undefined {
  if (!project) return undefined;
  const roots = (project.projects ?? []).filter(Boolean);
  if (!roots.length) return undefined;
  if (!cwd) return roots[0];
  const containing = roots
    .filter((root) => isWithinRoot(cwd, root))
    .sort((a, b) => normalizeRoot(b).length - normalizeRoot(a).length);
  return containing[0] ?? roots[0];
}

/**
 * The staged composer draft.
 *
 * References ride below the prompt in a fenced block so they read as cited
 * material rather than as further instructions — a router that silently
 * appends imperatives to a prompt the user is about to send is worse than one
 * that appends nothing. Kept mechanical: the lines carry real session ids and
 * dates, so a wrong one is checkable at a glance.
 */
export function composeDraft(prompt: string, references?: readonly string[]): string {
  const body = prompt.trim();
  const lines = (references ?? []).map((r) => r.trim()).filter(Boolean);
  if (lines.length === 0) return body;
  const block = ["```", "recent material", ...lines.map((r) => `  ${r}`), "```"].join("\n");
  return body ? `${body}\n\n${block}` : block;
}
