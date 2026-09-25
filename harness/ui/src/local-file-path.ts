/** Markdown may prefix a Windows drive path with `/` as if it were a URL path. */
export function normalizeLocalFilePath(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}
