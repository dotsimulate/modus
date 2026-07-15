import { resolve } from "path";

export type ProjectProfileLike = {
  displayName?: string;
  projects?: string[];
};

export type SessionProjectDescriptor = {
  id: string;
  name: string;
  roots: string[];
};

export type SessionProjectMatch = {
  projectId: string | null;
  projectName: string | null;
  projectRoot: string | null;
  explicit: boolean;
};

/** Normalize only for comparison. Returned API paths retain their configured spelling. */
export function normalizeProjectPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const absolute = /^(?:[A-Za-z]:[\\/]|\/)/.test(trimmed) ? trimmed : resolve(trimmed);
  const slashed = absolute.replace(/\\/g, "/");
  const normalized = slashed === "/" ? "/" : slashed.replace(/\/+$/, "");
  return /^[A-Za-z]:(?:\/|$)/.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function isWithinProjectRoot(cwd: string, root: string): boolean {
  const candidate = normalizeProjectPath(cwd);
  const boundary = normalizeProjectPath(root);
  if (!candidate || !boundary) return false;
  if (boundary === "/") return candidate.startsWith("/");
  return candidate === boundary || candidate.startsWith(`${boundary}/`);
}

export function buildProjectDescriptors(
  profiles: Record<string, ProjectProfileLike>,
): SessionProjectDescriptor[] {
  return Object.entries(profiles)
    .map(([id, profile]) => ({
      id,
      name: profile.displayName?.trim() || id,
      roots: Array.from(new Set((profile.projects ?? []).map((root) => root.trim()).filter(Boolean))),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Explicit session ownership wins. Legacy rows without ownership are matched
 * to the most-specific configured root so nested projects are deterministic.
 */
export function resolveSessionProject(
  session: { user_profile?: string | null; cwd?: string | null },
  projects: SessionProjectDescriptor[],
): SessionProjectMatch {
  if (session.user_profile) {
    const explicit = projects.find((project) => project.id === session.user_profile);
    if (explicit) {
      const root = explicit.roots
        .filter((candidate) => !!session.cwd && isWithinProjectRoot(session.cwd, candidate))
        .sort((a, b) => normalizeProjectPath(b).length - normalizeProjectPath(a).length)[0]
        ?? null;
      return {
        projectId: explicit.id,
        projectName: explicit.name,
        projectRoot: root,
        explicit: true,
      };
    }

    // Preserve deleted/temporarily unavailable project identities instead of
    // silently reassigning their sessions by path.
    return {
      projectId: session.user_profile,
      projectName: session.user_profile,
      projectRoot: null,
      explicit: true,
    };
  }

  if (!session.cwd) {
    return { projectId: null, projectName: null, projectRoot: null, explicit: false };
  }

  let best: { project: SessionProjectDescriptor; root: string; length: number } | null = null;
  for (const project of projects) {
    for (const root of project.roots) {
      if (!isWithinProjectRoot(session.cwd, root)) continue;
      const length = normalizeProjectPath(root).length;
      if (!best || length > best.length) best = { project, root, length };
    }
  }

  if (!best) return { projectId: null, projectName: null, projectRoot: null, explicit: false };
  return {
    projectId: best.project.id,
    projectName: best.project.name,
    projectRoot: best.root,
    explicit: false,
  };
}
