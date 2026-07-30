/**
 * Build-time generation of reference docs for the approved authoring surface.
 *
 * Why build time, rather than on read the way `generated/move-ops` works:
 * packaged builds do not stage `move-types.ts` or `harness-context.ts`, and
 * `typescript` is a peer/dev dependency that never reaches a packaged runtime —
 * so a read-time generator would work in dev and return nothing in a package.
 * `harness/docs/` *is* staged, so generated markdown ships as an ordinary doc.
 * That buys a property hand-written docs do not have: the shipped reference
 * always describes the shipped code, because both come from the same build.
 *
 * The generator quotes declarations verbatim and never paraphrases them. A
 * declaration that is renamed or removed makes this throw by name instead of
 * silently emitting a shorter list — which is exactly how hand-maintained field
 * lists rot (harness-context.md listed the orchestration members and omitted
 * `wake` and `insertArtifact` for weeks).
 *
 * Read-time generation stays correct for anything that depends on the user's
 * machine (`generated/move-ops` scans the project's own `.modus/moves`).
 * Build-time generation is for anything that describes this source tree.
 *
 * Regenerate with `bun run docs:generate` from `harness/`. `docs-generated.test.ts`
 * fails when the committed output drifts from source, so drift is a red test.
 */

import * as ts from "typescript";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HARNESS_DIR = join(import.meta.dir, "..");
const GENERATED_DIR = join(HARNESS_DIR, "docs", "generated");

/** Doc id → builder. Add a generator here and to `docs-generated.test.ts`. */
export const GENERATED_DOCS: Record<string, () => string> = {
  "authoring-contracts": buildAuthoringContracts,
};

// ── Source access ──

const sourceCache = new Map<string, ts.SourceFile>();

/** `file` is relative to `harness/`, e.g. "move-types.ts". */
function sourceFile(file: string): ts.SourceFile {
  const cached = sourceCache.get(file);
  if (cached) return cached;
  const text = readFileSync(join(HARNESS_DIR, file), "utf-8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  sourceCache.set(file, sf);
  return sf;
}

type Declaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

/**
 * Locate a declaration by name. Throws rather than returning null: a stale
 * allowlist must fail the build, not quietly shrink the reference.
 */
export function findDeclaration(file: string, name: string): Declaration {
  const sf = sourceFile(file);
  for (const statement of sf.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
      && statement.name.text === name
    ) {
      return statement;
    }
  }
  throw new Error(
    `${file}: no interface or type alias named "${name}". The approved-surface list in `
    + `scripts/generate-docs.ts is stale — update it, or restore the declaration.`,
  );
}

/** The declaration's own text including its JSDoc, normalized to LF. */
function quoteDeclaration(file: string, name: string): string {
  const sf = sourceFile(file);
  const node = findDeclaration(file, name);
  return sf.text
    .slice(node.getStart(sf, /* includeJsDocComment */ true), node.getEnd())
    .replace(/\r\n/g, "\n")
    .trimEnd();
}

interface Member {
  name: string;
  optional: boolean;
}

/** Declared member names, in source order. Empty for type aliases. */
function members(file: string, name: string): Member[] {
  const node = findDeclaration(file, name);
  if (!ts.isInterfaceDeclaration(node)) return [];
  const out: Member[] = [];
  for (const member of node.members) {
    const memberName = member.name;
    if (!memberName || !ts.isIdentifier(memberName)) continue;
    const optional = "questionToken" in member && member.questionToken !== undefined;
    out.push({ name: memberName.text, optional });
  }
  return out;
}

// ── The approved surface ──
//
// An explicit allowlist, not a sweep of every exported type. These are the
// contracts authored content is expected to code against; everything else in
// these files is internal and stays undocumented on purpose.

interface SurfaceEntry {
  name: string;
  file: string;
  /** One line on when an author is holding this context. */
  when: string;
}

const CONTEXTS: SurfaceEntry[] = [
  {
    name: "MoveContext",
    file: "move-types.ts",
    when: "passed to a move's `gather()` and `onSubmit()`",
  },
  {
    name: "MoveApiContext",
    file: "move-types.ts",
    when: "passed to a move's API op handlers (what `modus_submit` reaches)",
  },
  {
    name: "HarnessContext",
    file: "harness-context.ts",
    when: "the canonical server-side capability contract the others are sourced from",
  },
];

const SUPPORTING: SurfaceEntry[] = [
  { name: "MoveApiHandler", file: "move-types.ts", when: "the handler signature" },
  { name: "MoveCapabilities", file: "move-types.ts", when: "the capability gates a move declares" },
  { name: "MoveStateAPI", file: "move-types.ts", when: "`ctx.state`" },
  { name: "MoveDB", file: "move-types.ts", when: "`ctx.db`" },
  { name: "MoveSecrets", file: "move-types.ts", when: "`ctx.secrets`" },
  { name: "HarnessBridge", file: "move-types.ts", when: "`ctx.harness` on MoveContext" },
  { name: "HarnessSelf", file: "harness-context.ts", when: "`ctx.self` — identity and trust tier" },
  { name: "HarnessSessions", file: "harness-context.ts", when: "`ctx.sessions`" },
  { name: "HarnessChannels", file: "harness-context.ts", when: "`ctx.channels` — the egress primitive" },
  { name: "HarnessMoves", file: "harness-context.ts", when: "`ctx.moves`" },
  { name: "HarnessActions", file: "harness-context.ts", when: "`ctx.actions`" },
  { name: "HarnessArtifacts", file: "harness-context.ts", when: "`ctx.artifacts`" },
  { name: "HarnessTerminalApi", file: "harness-context.ts", when: "`ctx.terminal`" },
  { name: "WakeWhen", file: "harness-context.ts", when: "the `wake()` schedule argument" },
  { name: "WakeHandle", file: "harness-context.ts", when: "what `wake()` returns" },
  { name: "ChannelResult", file: "harness-context.ts", when: "what `channels.send()` returns" },
];

// ── Rendering ──

function frontmatter(title: string, covers: string[]): string[] {
  return [
    "---",
    `title: ${title}`,
    "audience: dev",
    `covers: ${covers.join(" ")}`,
    "---",
    "",
    // One line on purpose: docs-registry's extractSummary only skips lines that
    // *start* with "<!--", so a wrapped banner's continuation becomes the index
    // summary shown in docs_list.
    "<!-- GENERATED FILE — do not edit. Run `bun run docs:generate` from harness/. Drift fails docs-generated.test.ts. -->",
    "",
  ];
}

function matrixRows(surfaces: SurfaceEntry[]): string[] {
  const byName = surfaces.map((s) => ({ surface: s, members: members(s.file, s.name) }));
  const every = [...new Set(byName.flatMap((s) => s.members.map((m) => m.name)))].sort();

  const rows = [
    `| member | ${surfaces.map((s) => `\`${s.name}\``).join(" | ")} |`,
    `|---|${surfaces.map(() => "---").join("|")}|`,
  ];
  for (const member of every) {
    const cells = byName.map(({ members: list }) => {
      const hit = list.find((m) => m.name === member);
      if (!hit) return "—";
      return hit.optional ? "opt" : "yes";
    });
    rows.push(`| \`${member}\` | ${cells.join(" | ")} |`);
  }
  return rows;
}

function onlyIn(a: SurfaceEntry, b: SurfaceEntry): string[] {
  const bNames = new Set(members(b.file, b.name).map((m) => m.name));
  return members(a.file, a.name)
    .map((m) => m.name)
    .filter((name) => !bNames.has(name))
    .sort();
}

function declarationSections(entries: SurfaceEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    out.push(`### \`${entry.name}\` — ${entry.when}`, "", `\`harness/${entry.file}\``, "", "```ts");
    out.push(quoteDeclaration(entry.file, entry.name), "```", "");
  }
  return out;
}

export function buildAuthoringContracts(): string {
  const covers = [...new Set([...CONTEXTS, ...SUPPORTING].map((e) => `harness/${e.file}`))].sort();
  const moveCtx = CONTEXTS[0]!;
  const apiCtx = CONTEXTS[1]!;

  const lines = [
    ...frontmatter("Authoring Contracts (generated)", covers),
    "# Authoring Contracts (generated)",
    "",
    "Exactly which members each authoring surface exposes, quoted from source. Hand-written",
    "docs describe intent and invariants; this describes shape. When the two disagree, this",
    "one is right — it is regenerated from the declarations themselves.",
    "",
    "## Surface matrix",
    "",
    "`yes` = declared and required, `opt` = declared and optional, `—` = **absent**, not optional.",
    "An absent member is a hard boundary: reaching for it is a type error in TypeScript and",
    "`undefined` at runtime in plain JS.",
    "",
    ...matrixRows(CONTEXTS),
    "",
    `### Only on \`${moveCtx.name}\``,
    "",
    `Not reachable from an API op handler: ${onlyIn(moveCtx, apiCtx).map((n) => `\`${n}\``).join(", ")}.`,
    "",
    `### Only on \`${apiCtx.name}\``,
    "",
    `Not reachable from \`gather()\`/\`onSubmit()\`: ${onlyIn(apiCtx, moveCtx).map((n) => `\`${n}\``).join(", ")}.`,
    "",
    "## Contexts",
    "",
    ...declarationSections(CONTEXTS),
    "## Supporting types",
    "",
    ...declarationSections(SUPPORTING),
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}

// ── Entry point ──

function main(): void {
  mkdirSync(GENERATED_DIR, { recursive: true });
  for (const [id, build] of Object.entries(GENERATED_DOCS)) {
    const path = join(GENERATED_DIR, `${id}.md`);
    writeFileSync(path, build(), "utf-8");
    console.log(`generated docs/generated/${id}.md`);
  }
}

if (import.meta.main) main();
