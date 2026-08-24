/**
 * Lint authored pages against what the renderer actually does.
 *
 *   bun run scripts/lint-pages.ts                 # built-in pages + this project's
 *   bun run scripts/lint-pages.ts <file|dir>...   # specific targets
 *   bun run scripts/lint-pages.ts --quiet         # errors and warnings only
 *
 * Exits non-zero if any page trips an `error` rule, so it can gate a change.
 * This is the fast half of page review: it needs no browser and no running
 * app, so a page can be iterated on until it is clean before anyone looks at
 * it. The other half is `/api/page-inspect`, which reports measured geometry
 * from a page that is actually on screen.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, resolve } from "path";
import { lintConversationLens, lintPage, formatFindings, worstSeverity } from "../ui/src/page-lint";
import type { LintablePage } from "../ui/src/page-lint";
import { WIDGET_META } from "../ui/src/widgets/catalog";
import type { ConversationLensDefinitionV1, ConversationProjectionRegistryEntry } from "../sdk/types";

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const targets = args.filter((a) => !a.startsWith("--"));

function jsonFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name));
}

function resolveTargets(): string[] {
  if (targets.length > 0) {
    return targets.flatMap((target) => {
      const path = resolve(target);
      return statSync(path).isDirectory() ? jsonFilesIn(path) : [path];
    });
  }
  const defaults = [
    join(import.meta.dir, "..", "pages"),
    join(import.meta.dir, "..", "lenses"),
    join(import.meta.dir, "..", "..", ".modus", "pages"),
    join(import.meta.dir, "..", "..", ".modus", "lenses"),
  ];
  return defaults.filter(existsSync).flatMap(jsonFilesIn);
}

function localProjectionEntries(): ConversationProjectionRegistryEntry[] {
  const roots = [
    { dir: join(import.meta.dir, "..", "..", ".modus", "projections"), kind: "project" as const, label: "project" },
    { dir: join(import.meta.dir, "..", "projections"), kind: "harness" as const, label: "Modus" },
  ];
  const entries: ConversationProjectionRegistryEntry[] = [];
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    for (const child of readdirSync(root.dir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const manifestPath = join(root.dir, child.name, "projection.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const definition = JSON.parse(readFileSync(manifestPath, "utf8"));
        entries.push({
          id: definition.id ?? child.name,
          status: definition.contract === "conversation-projection@1" ? "available" : "incompatible",
          source: { kind: root.kind, label: root.label, key: `${root.kind}:${child.name}` },
          definition,
        });
      } catch (error) {
        entries.push({
          id: child.name,
          status: "invalid",
          source: { kind: root.kind, label: root.label, key: `${root.kind}:${child.name}` },
          reason: (error as Error).message,
        });
      }
    }
  }
  const winners = new Map<string, ConversationProjectionRegistryEntry>();
  for (const entry of entries) if (!winners.has(entry.id)) winners.set(entry.id, entry);
  return [...winners.values()];
}

const projections = localProjectionEntries();

let errors = 0;
let warnings = 0;

for (const path of resolveTargets()) {
  let page: LintablePage | ConversationLensDefinitionV1;
  try {
    page = JSON.parse(readFileSync(path, "utf8")) as LintablePage;
  } catch (err) {
    console.log(`\n### ${path}\n[error] unparseable: ${(err as Error).message}`);
    errors += 1;
    continue;
  }

  const findings = (page as { contract?: string }).contract === "conversation-lens@1"
    ? lintConversationLens(page as ConversationLensDefinitionV1, WIDGET_META, projections)
    : lintPage(page as LintablePage, WIDGET_META);
  const shown = quiet ? findings.filter((f) => f.severity !== "info") : findings;
  errors += findings.filter((f) => f.severity === "error").length;
  warnings += findings.filter((f) => f.severity === "warning").length;

  const verdict = worstSeverity(findings) ?? "clean";
  console.log(`\n### ${path}  ->  ${verdict}`);
  if (shown.length > 0) console.log(formatFindings(shown));
}

console.log(`\n${errors} error(s), ${warnings} warning(s)`);
process.exit(errors > 0 ? 1 : 0);
