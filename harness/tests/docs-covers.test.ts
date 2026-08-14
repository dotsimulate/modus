import { resolve as resolveTestSourceDir } from "node:path";
import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "fs";
import { relative, resolve } from "path";
import { createDocsRegistry } from "../docs-registry";

const repoRoot = resolve(resolveTestSourceDir(import.meta.dir, ".."), "..");

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
}

function coveredPathExists(pattern: string): boolean {
  if (!pattern.includes("*")) return existsSync(resolve(repoRoot, pattern));
  const wildcard = pattern.indexOf("*");
  const slash = pattern.lastIndexOf("/", wildcard);
  const base = resolve(repoRoot, slash >= 0 ? pattern.slice(0, slash) : ".");
  if (!existsSync(base)) return false;
  const matches = globRegex(pattern);
  const pending = [base];
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = resolve(dir, entry.name);
      const repoPath = relative(repoRoot, absolute).replace(/\\/g, "/");
      if (matches.test(repoPath)) return true;
      if (entry.isDirectory()) pending.push(absolute);
    }
  }
  return false;
}

test("every shipped doc covers an existing source path", () => {
  const registry = createDocsRegistry({ docsDir: resolve(resolveTestSourceDir(import.meta.dir, ".."), "docs") });
  const missing = registry.listDocs().flatMap((doc) => (doc.covers ?? [])
    // Project-authored examples describe runtime locations that need not exist
    // in the Modus source checkout.
    .filter((path) => !path.startsWith(".modus/") && !coveredPathExists(path))
    .map((path) => `${doc.id}: ${path}`));
  expect(missing).toEqual([]);
});
