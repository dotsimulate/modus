/**
 * docs-registry tests — isolated temp fixtures only. No live home, DB, ports,
 * or the real harness/docs tree.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDocsRegistry, type DocsRegistry } from "./docs-registry";

let root: string;
let registry: DocsRegistry;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "modus-docs-registry-"));
  const docsDir = join(root, "docs");
  const movesDir = join(root, "moves");
  mkdirSync(join(docsDir, "sdk"), { recursive: true });
  mkdirSync(join(movesDir, "fixture-move"), { recursive: true });

  writeFileSync(join(docsDir, "moves.md"), [
    "---",
    "title: Moves",
    "lastUpdated: 2026-07-01",
    "covers: harness/move-runner.ts harness/move-types.ts",
    "---",
    "",
    "# Moves",
    "",
    "Moves are the user-facing invocation primitive with widgets and tokens.",
    "",
    "## Persistent",
    "",
    "Persistent moves re-run gather on every turn.",
  ].join("\n"));

  writeFileSync(join(docsDir, "getting-started.md"), [
    "---",
    "title: Getting Started",
    "audience: user",
    "---",
    "",
    "# Getting Started",
    "",
    "A friendly introduction for new users of the app.",
  ].join("\n"));

  // No frontmatter at all — title falls back to the id.
  writeFileSync(join(docsDir, "sdk", "guide.md"), [
    "# SDK Guide",
    "",
    "Integrate external clients using the software development kit.",
  ].join("\n"));

  writeFileSync(join(movesDir, "fixture-move", "move.json"), JSON.stringify({
    name: "fixture-move",
    label: "Fixture",
    description: "A fixture move for op scanning.",
    mode: "inline",
    api: {
      ops: {
        do_thing: { description: "Does the thing.", schema: { type: "object" } },
        other_op: { description: "Other op without schema." },
      },
    },
    capabilities: { shell: false },
  }, null, 2));

  registry = createDocsRegistry({ docsDir, builtinMovesDir: movesDir });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listDocs", () => {
  test("returns file docs plus the generated move-ops entry", () => {
    const ids = registry.listDocs().map((e) => e.id);
    expect(ids).toContain("moves");
    expect(ids).toContain("getting-started");
    expect(ids).toContain("sdk/guide");
    expect(ids).toContain("generated/move-ops");
  });

  test("parses frontmatter and derives summaries", () => {
    const moves = registry.listDocs().find((e) => e.id === "moves");
    expect(moves?.title).toBe("Moves");
    expect(moves?.audience).toBe("dev");
    expect(moves?.lastUpdated).toBe("2026-07-01");
    expect(moves?.covers).toEqual(["harness/move-runner.ts", "harness/move-types.ts"]);
    expect(moves?.summary).toContain("user-facing invocation primitive");
  });

  test("title falls back to the id when frontmatter is absent", () => {
    const guide = registry.listDocs().find((e) => e.id === "sdk/guide");
    expect(guide?.title).toBe("sdk/guide");
    expect(guide?.audience).toBe("dev");
  });

  test("audience filter narrows results", () => {
    const userDocs = registry.listDocs({ audience: "user" });
    expect(userDocs.map((e) => e.id)).toEqual(["getting-started"]);
  });
});

describe("getDoc", () => {
  test("returns content with frontmatter stripped", () => {
    const doc = registry.getDoc("moves");
    expect(doc).not.toBeNull();
    expect(doc!.content).toContain("# Moves");
    expect(doc!.content).not.toContain("lastUpdated");
  });

  test("resolves nested ids", () => {
    expect(registry.getDoc("sdk/guide")?.content).toContain("SDK Guide");
  });

  test("unknown ids return null", () => {
    expect(registry.getDoc("nope")).toBeNull();
  });

  test("rejects traversal and absolute ids", () => {
    expect(registry.getDoc("../secrets")).toBeNull();
    expect(registry.getDoc("..\\secrets")).toBeNull();
    expect(registry.getDoc("/etc/passwd")).toBeNull();
    expect(registry.getDoc("C:/windows/win.ini")).toBeNull();
  });
});

describe("searchDocs", () => {
  test("returns one result set per query (batch contract)", () => {
    const results = registry.searchDocs(["persistent gather", "software development kit"]);
    expect(results).toHaveLength(2);
    expect(results[0]!.query).toBe("persistent gather");
    expect(results[0]!.results[0]?.id).toBe("moves");
    expect(results[1]!.results[0]?.id).toBe("sdk/guide");
  });

  test("no-match queries return empty results, not errors", () => {
    const [result] = registry.searchDocs(["zzzqqqxyz"]);
    expect(result!.results).toEqual([]);
  });

  test("hits include line-numbered snippets", () => {
    const [result] = registry.searchDocs(["persistent"]);
    const hit = result!.results.find((h) => h.id === "moves");
    expect(hit).toBeDefined();
    expect(hit!.snippets.length).toBeGreaterThan(0);
    expect(hit!.snippets[0]!.line).toBeGreaterThan(0);
    expect(hit!.snippets.some((s) => s.text.toLowerCase().includes("persistent"))).toBe(true);
  });

  test("title matches outrank body-only matches", () => {
    const [result] = registry.searchDocs(["moves"]);
    expect(result!.results[0]?.id).toBe("moves");
  });
});

describe("search ranking", () => {
  // A second isolated corpus, shaped to expose the ranking failures the field
  // report found: raw term frequency with no IDF, and snippets taken in
  // first-match order rather than by relevance.
  let rankRoot: string;
  let ranked: DocsRegistry;

  beforeAll(() => {
    rankRoot = mkdtempSync(join(tmpdir(), "modus-docs-ranking-"));
    const docsDir = join(rankRoot, "docs");
    mkdirSync(docsDir, { recursive: true });

    // The doc that actually defines the symbol. Short, mentions it a few times.
    writeFileSync(join(docsDir, "moves.md"), [
      "---", "title: Moves", "---", "",
      "# Moves",
      "",
      "Moves are the invocation primitive.",
      "",
      "## API registration",
      "",
      "`registerMoveApi` persists the registration when a move declares api ops.",
      "Calling registerMoveApi twice for one instance is idempotent.",
    ].join("\n"));

    // A long prose doc full of the common words, and no mention of the symbol.
    const filler = Array.from({ length: 40 }, (_, i) => (
      `The harness system move runner handles the move registration path number ${i}.`
    ));
    writeFileSync(join(docsDir, "architecture.md"), [
      "---", "title: Architecture", "---", "",
      "# Architecture",
      "",
      ...filler,
    ].join("\n"));

    // Preamble mentions the term once; the real explanation is much later and
    // is the line a reader wants quoted back.
    writeFileSync(join(docsDir, "providers.md"), [
      "---", "title: Provider System", "---", "",
      "# Provider System",
      "",
      "Providers are execution backends.",
      "",
      ...Array.from({ length: 12 }, () => "Unrelated filler line about configuration."),
      "",
      "## Tool catalog",
      "",
      "The provider tool catalog maps each provider family to its tool names.",
    ].join("\n"));

    // Title says "checkpoint"; the body never does.
    writeFileSync(join(docsDir, "rewind.md"), [
      "---", "title: Checkpoint and Rewind", "---", "",
      "# Rewind",
      "",
      "Rewinding restores an earlier state of the working tree.",
    ].join("\n"));

    ranked = createDocsRegistry({ docsDir });
  });

  afterAll(() => {
    rmSync(rankRoot, { recursive: true, force: true });
  });

  test("a single-identifier query ranks the defining doc first", () => {
    const [result] = ranked.searchDocs(["registerMoveApi"]);
    expect(result!.results[0]?.id).toBe("moves");
  });

  test("a backticked identifier is matched case-sensitively against the body", () => {
    const [result] = ranked.searchDocs(["`registerMoveApi`"]);
    expect(result!.results[0]?.id).toBe("moves");
    // The identifier boost must actually be doing work, not just tokenization.
    const plain = ranked.searchDocs(["registermoveapi"])[0]!.results[0]!;
    expect(result!.results[0]!.score).toBeGreaterThan(plain.score);
  });

  test("a long prose query does not outscore a precise identifier query", () => {
    // The reported inversion: a six-word prose query stacked raw term
    // frequency high enough to dwarf a one-token identifier hit, so relative
    // scores told an agent the wrong thing about which answer was better.
    const identifier = ranked.searchDocs(["registerMoveApi"])[0]!.results[0]!;
    const prose = ranked.searchDocs([
      "the harness system move runner registration path",
    ])[0]!.results[0]!;
    expect(identifier.score).toBeGreaterThan(prose.score);
  });

  test("a common word does not let the longest doc bury the specific one", () => {
    // "registration" appears 40 times in architecture.md and twice in moves.md,
    // but only moves.md also matches the rare term.
    const [result] = ranked.searchDocs(["registerMoveApi registration"]);
    expect(result!.results[0]?.id).toBe("moves");
  });

  test("snippets quote the best matching lines, not the preamble", () => {
    const [result] = ranked.searchDocs(["provider tool catalog"]);
    const hit = result!.results.find((h) => h.id === "providers");
    expect(hit).toBeDefined();
    const texts = hit!.snippets.map((s) => s.text);
    expect(texts.some((t) => t.includes("tool catalog maps each provider family"))).toBe(true);
    // The substantive line and its section heading take the top slots. The bare
    // H1 is the one line with nothing to say, so it must not displace them —
    // it previously did, because every heading got an unconditional bonus.
    expect(texts).not.toContain("# Provider System");
  });

  test("a title-only match is suppressed", () => {
    // "Checkpoint" is in rewind.md's title and nowhere in its body, so it is
    // not an answer to a checkpoint question.
    const [result] = ranked.searchDocs(["checkpoint"]);
    expect(result!.results.map((h) => h.id)).not.toContain("rewind");

    // The same doc still ranks for a term its body genuinely covers.
    const [real] = ranked.searchDocs(["rewinding"]);
    expect(real!.results.map((h) => h.id)).toContain("rewind");
  });
});

describe("generated/move-ops", () => {
  test("inventories declared api ops per move", () => {
    const doc = registry.getDoc("generated/move-ops");
    expect(doc).not.toBeNull();
    expect(doc!.generated).toBe(true);
    expect(doc!.content).toContain("## fixture-move (harness)");
    expect(doc!.content).toContain("`do_thing` — Does the thing. (schema: yes)");
    expect(doc!.content).toContain("`other_op` — Other op without schema. (schema: no)");
    expect(doc!.content).toContain('"shell":false');
  });

  test("includes project moves when cwd is provided", () => {
    const projectRoot = join(root, "project");
    mkdirSync(join(projectRoot, ".modus", "moves", "proj-move"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".modus", "moves", "proj-move", "move.json"),
      JSON.stringify({ name: "proj-move", description: "Project move." }),
    );
    const doc = registry.getDoc("generated/move-ops", { cwd: projectRoot });
    expect(doc!.content).toContain("## proj-move (project)");
    expect(doc!.content).toContain("- api ops: none");
  });
});

describe("covers: none sentinel", () => {
  test("declares no source without pretending to cover files", () => {
    const dir = mkdtempSync(join(tmpdir(), "modus-docs-covers-"));
    writeFileSync(join(dir, "pattern.md"), [
      "---",
      "title: A Pattern",
      "covers: none",
      "---",
      "",
      "A convention rather than a code feature, so there is nothing to verify.",
    ].join("\n"));
    writeFileSync(join(dir, "forgot.md"), ["# Forgot", "", "No covers declared here."].join("\n"));

    const reg = createDocsRegistry({ docsDir: dir });
    const pattern = reg.listDocs().find((e) => e.id === "pattern");
    // Distinguishable from "the author forgot": covers is empty either way, so a
    // drift audit needs the explicit flag to tell the two apart.
    expect(pattern?.coversNone).toBe(true);
    expect(pattern?.covers).toBeUndefined();

    const forgot = reg.listDocs().find((e) => e.id === "forgot");
    expect(forgot?.coversNone).toBeUndefined();
    expect(forgot?.covers).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("search negatives", () => {
  test("reports identifiers and terms that appear in no doc", () => {
    const [hit] = registry.searchDocs(["`createTestContext` for moves"]);
    expect(hit!.missingIdentifiers).toContain("createTestContext");
    expect(hit!.missingTerms).toContain("createtestcontext");
    // The point of the negative: a plausible-looking hit is still returned, so
    // without it the caller cannot tell this from a real answer.
    expect(hit!.results.length).toBeGreaterThan(0);
  });

  test("reports nothing missing when every term is present", () => {
    const [hit] = registry.searchDocs(["persistent moves gather"]);
    expect(hit!.missingIdentifiers).toEqual([]);
    expect(hit!.missingTerms).toEqual([]);
  });

  test("an empty query still carries the negative fields", () => {
    const [hit] = registry.searchDocs(["!!"]);
    expect(hit!.results).toEqual([]);
    expect(hit!.missingTerms).toEqual([]);
    expect(hit!.missingIdentifiers).toEqual([]);
  });
});

describe("snippet selection", () => {
  test("a heading matching one common term loses to a prose line", () => {
    const dir = mkdtempSync(join(tmpdir(), "modus-docs-snippet-"));
    writeFileSync(join(dir, "widget.md"), [
      "---",
      "title: Widget",
      "---",
      "",
      // More headings than snippet slots, so the prose line can only appear if
      // it outranks them.
      "## Widget setup",
      "## Widget teardown",
      "## Widget caching",
      "## Widget events",
      "A widget is mounted with an api token and an instance id.",
    ].join("\n"));
    const reg = createDocsRegistry({ docsDir: dir });
    const [hit] = reg.searchDocs(["widget"]);
    const texts = hit!.results[0]!.snippets.map((s) => s.text);
    // Regression guard: the heading bonus used to make every "## Widget …" line
    // outrank prose on a one-term query, so the three slots filled with a table
    // of contents and the only informative line was dropped.
    expect(texts.some((t) => t.includes("mounted with an api token"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("summary extraction", () => {
  test("skips a wrapped HTML comment instead of quoting its continuation", () => {
    const dir = mkdtempSync(join(tmpdir(), "modus-docs-summary-"));
    writeFileSync(join(dir, "gen.md"), [
      "---",
      "title: Generated Thing",
      "---",
      "",
      "<!-- GENERATED FILE — do not edit.",
      "     Regenerate with a command. -->",
      "",
      "The real summary line that a reader should see.",
    ].join("\n"));
    const reg = createDocsRegistry({ docsDir: dir });
    const entry = reg.listDocs().find((e) => e.id === "gen");
    expect(entry?.summary).toBe("The real summary line that a reader should see.");
    expect(entry?.summary).not.toContain("-->");
    rmSync(dir, { recursive: true, force: true });
  });
});
