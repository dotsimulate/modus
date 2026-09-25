import { resolveMarkdownLinkTarget } from "./markdown-links";

export type MarkdownImageTarget =
  | { kind: "local"; path: string }
  | { kind: "web"; url: string }
  | { kind: "unsupported" };

/** Image paths belong to the backend, never the phone or desktop webview. */
export function resolveMarkdownImageTarget(
  src: string,
  sourceFile?: string,
  cwd?: string | null,
): MarkdownImageTarget {
  const value = src.trim();
  // Existing backend media URLs (for example repository README images).
  if (value.startsWith("/api/")) return { kind: "web", url: value };
  const base = sourceFile || (cwd ? `${cwd.replace(/[\\/]+$/, "")}/_` : undefined);
  const target = resolveMarkdownLinkTarget(value, base);
  if (target.kind === "local") return { kind: "local", path: target.path };
  if (target.kind === "web") return target;
  return { kind: "unsupported" };
}
