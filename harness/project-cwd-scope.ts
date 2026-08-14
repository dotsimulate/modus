export type ProjectCwdScope = {
  sql: string;
  params: string[];
};

function normalizeRoot(root: string): string {
  const normalized = root.replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** Build an exact-or-descendant project-root predicate for a SQLite path column. */
export function buildProjectCwdScope(column: "cwd" | "s.cwd", roots: string[]): ProjectCwdScope {
  const normalizedColumn = `REPLACE(${column}, '\\', '/')`;
  const clauses: string[] = [];
  const params: string[] = [];

  for (const value of roots) {
    const root = normalizeRoot(value);
    clauses.push(`(${normalizedColumn} COLLATE NOCASE = ? OR ${normalizedColumn} LIKE ? ESCAPE '\\')`);
    params.push(root, `${escapeLike(root)}${root.endsWith("/") ? "" : "/"}%`);
  }

  return { sql: clauses.join(" OR "), params };
}
