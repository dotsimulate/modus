import { resolve } from "path";

/** True when `filePath` is `root` itself or sits beneath it, case-folded on Windows. */
export function isWithinRoot(filePath: string, root: string): boolean {
  const target = resolve(filePath);
  const base = resolve(root);
  if (process.platform === "win32") {
    const normalizedTarget = target.toLowerCase();
    const normalizedBase = base.toLowerCase();
    return normalizedTarget === normalizedBase
      || normalizedTarget.startsWith(`${normalizedBase}\\`)
      || normalizedTarget.startsWith(`${normalizedBase}/`);
  }
  return target === base || target.startsWith(`${base}/`);
}

/** Resolve an explicit UI cwd only when it belongs to a configured project. */
export function configuredRootsForCwd(
  cwd: string,
  existingRoots: string[],
  configuredProjectRoots: string[],
): string[] {
  const resolvedCwd = resolve(cwd);
  const owningRoot = [...existingRoots, ...configuredProjectRoots]
    .map((root) => resolve(root))
    .find((root) => isWithinRoot(resolvedCwd, root));
  return owningRoot ? [owningRoot, resolvedCwd] : [];
}
