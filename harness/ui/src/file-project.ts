type FileProject = { name: string; displayName: string; projects: string[] };

function normalize(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const trimmed = slashed.replace(/\/+$/, "") || "/";
  return /^(?:[A-Za-z]:|\/\/)/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/** Longest containing root wins; a sibling sharing a prefix is not inside. */
export function projectForFile<T extends FileProject>(path: string, projects: T[]): T | undefined {
  const candidate = normalize(path);
  let match: T | undefined;
  let length = -1;
  for (const project of projects) {
    for (const root of project.projects) {
      if (!root) continue;
      const boundary = normalize(root);
      if (boundary.length > length && (candidate === boundary
        || candidate.startsWith(boundary === "/" ? "/" : `${boundary}/`))) {
        match = project;
        length = boundary.length;
      }
    }
  }
  return match;
}
