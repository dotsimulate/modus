/** Recent CWD path storage — localStorage-backed */

const RECENT_PATHS_KEY = "harness:recent-cwds";
const MAX_RECENT = 8;

export function getRecentPaths(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_PATHS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addRecentPath(path: string) {
  if (!path.trim()) return;
  const paths = getRecentPaths().filter((p) => p !== path);
  paths.unshift(path);
  localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(paths.slice(0, MAX_RECENT)));
}
