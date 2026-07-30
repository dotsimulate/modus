/**
 * Docs Registry — index, retrieval, and batch search over the built-in
 * documentation set (recursive *.md under <resourcesDir>/docs) plus generated
 * reference docs.
 *
 * Two consumers share this module:
 *   - the HTTP API (/api/docs, /api/docs/*, /api/docs/search) feeding the
 *     user-facing docs widget/page;
 *   - the modus-brain move's API ops (docs_list / docs_search / docs_get),
 *     which let any provider's agent learn Modus interactively via modus_submit.
 *
 * Doc IDs are the file path relative to the docs dir without the .md extension,
 * forward slashes ("moves", "sdk/guide"). Reference docs are namespaced under
 * "generated/" and come in two kinds:
 *   - Read-time (virtual, built per request) for anything that depends on the
 *     caller's machine. generated/move-ops is the one: every discoverable move
 *     with its declared api ops, capabilities, and trust tier — the audit
 *     surface for "which ops are actually exposed" — and it scans the caller's
 *     own .modus/moves, so it cannot be precomputed.
 *   - Build-time (ordinary .md files under docs/generated/, written by
 *     scripts/generate-docs.ts) for anything that describes this source tree.
 *     Packaged builds do not stage the .ts sources those quote, so they must be
 *     generated before staging; docs/ is staged, so they ship as normal docs.
 * A virtual id wins over a file of the same name.
 *
 * Frontmatter contract (all optional): title, lastUpdated, covers
 * (space-separated source paths, or the literal `none`), audience
 * ("user" | "dev" | "agent", default "dev").
 *
 * `covers: none` is an explicit declaration that a doc describes a pattern or a
 * procedure rather than code (bootstrap.md, macos-setup.md). It sets
 * `coversNone` so a drift audit can tell "the author declared there is nothing
 * to check" apart from "the author forgot" — inventing plausible paths instead
 * would make the audit report a verification it never performed.
 *
 * The one-line `summary` is derived from the first body line that is not a
 * heading, fence, table row, or comment, so it is worth keeping that line
 * meaningful: it is what an agent reads in docs_list to decide whether to fetch.
 *
 * Ranking is IDF-weighted with saturating term frequency, a verbatim boost for
 * code-shaped spans in the query, and normalization by query length so scores
 * mean roughly the same thing across queries. Docs matching only in the title
 * are dropped. Snippets are the best-covering lines, not the first ones found.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve, sep } from "path";
import { APP_PATHS } from "./app-paths";

// ── Types ──

export type DocAudience = "user" | "dev" | "agent";

export interface DocIndexEntry {
  id: string;
  title: string;
  summary: string;
  audience: DocAudience;
  lastUpdated?: string;
  covers?: string[];
  /** `covers: none` — the doc declares it documents no source file. */
  coversNone?: boolean;
  generated?: boolean;
}

export interface DocContent extends DocIndexEntry {
  content: string;
}

export interface DocSearchSnippet {
  line: number;
  text: string;
}

export interface DocSearchHit {
  id: string;
  title: string;
  score: number;
  snippets: DocSearchSnippet[];
}

export interface DocSearchResult {
  query: string;
  results: DocSearchHit[];
  /**
   * Query terms that appear in no searched doc. Without this the caller cannot
   * tell a real answer from a doc that merely shares a common word, and the
   * observed consequence is guessing: a search for a symbol that exists nowhere
   * still returns a confident-looking ranked list.
   */
  missingTerms: string[];
  /**
   * Code-shaped spans from the query (backticked, camelCase, snake_case) that
   * appear verbatim in no searched doc. A miss here is the strongest possible
   * signal to stop reading docs and go read the source.
   */
  missingIdentifiers: string[];
}

export interface DocsQueryOpts {
  audience?: DocAudience | "all";
  /** Project root — includes .modus/moves in generated/move-ops when provided. */
  cwd?: string;
}

export interface DocsSearchOpts extends DocsQueryOpts {
  /** Max hits per query (default 5, cap 20). */
  limit?: number;
}

export interface DocsRegistry {
  listDocs(opts?: DocsQueryOpts): DocIndexEntry[];
  getDoc(id: string, opts?: DocsQueryOpts): DocContent | null;
  searchDocs(queries: string[], opts?: DocsSearchOpts): DocSearchResult[];
}

// ── Frontmatter ──

const AUDIENCES: DocAudience[] = ["user", "dev", "agent"];

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: raw };
  const header = raw.slice(raw.indexOf("\n") + 1, end);
  const body = raw.slice(raw.indexOf("\n", end + 1) + 1);
  const meta: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body };
}

/**
 * First body paragraph line that isn't a heading, fence, or comment.
 *
 * Comment state is tracked across lines: testing only for a leading `<!--` let a
 * wrapped HTML comment's continuation line become the summary, delimiter and
 * all, which is silent and lands in the one field agents read to triage a doc.
 */
function extractSummary(body: string): string {
  let inComment = false;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.startsWith("<!--")) {
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    if (line.startsWith("#") || line.startsWith("```")) continue;
    if (line.startsWith("|") || line.startsWith("---")) continue;
    const plain = line.replace(/[*_`]/g, "");
    return plain.length > 200 ? `${plain.slice(0, 197)}...` : plain;
  }
  return "";
}

function normalizeAudience(value: string | undefined): DocAudience {
  return AUDIENCES.includes(value as DocAudience) ? (value as DocAudience) : "dev";
}

// ── File scanning (mtime-cached parse) ──

interface ParsedDoc {
  entry: DocIndexEntry;
  body: string;
}

interface CacheSlot {
  mtimeMs: number;
  parsed: ParsedDoc;
}

function walkMarkdownFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name.startsWith(".")) continue;
    if (name.isDirectory()) {
      out.push(...walkMarkdownFiles(join(dir, name.name), `${prefix}${name.name}/`));
    } else if (name.isFile() && name.name.endsWith(".md")) {
      out.push(`${prefix}${name.name.slice(0, -3)}`);
    }
  }
  return out;
}

/** Reject traversal and absolute forms; normalize to forward slashes. */
function sanitizeDocId(id: string): string | null {
  const normalized = id.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("..") || /^[a-zA-Z]:/.test(normalized)) {
    return null;
  }
  return normalized;
}

// ── Search ──

function tokenizeQuery(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 2);
  return [...new Set(terms)].slice(0, 8);
}

/**
 * Code-shaped spans in the raw query: backticked text, camelCase, and
 * snake_case. Tokenization flattens these to lowercase words, which loses the
 * strongest signal a reader can give — "I want the doc that defines this exact
 * symbol". Matched case-sensitively against the body so `scoreDoc` beats prose
 * that merely says "score doc".
 */
function extractIdentifiers(query: string): string[] {
  const found = new Set<string>();
  for (const match of query.matchAll(/`([^`\n]{2,60})`/g)) {
    const span = match[1]!.trim();
    if (span) found.add(span);
  }
  for (const match of query.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g)) {
    found.add(match[0]!);
  }
  for (const match of query.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g)) {
    found.add(match[0]!);
  }
  return [...found].slice(0, 4);
}

const TITLE_WEIGHT = 10;
const HEADING_WEIGHT = 3;
const BODY_WEIGHT = 1;
const IDENTIFIER_WEIGHT = 12;
const SNIPPET_LIMIT = 3;
const SNIPPET_MAX_CHARS = 200;

interface TermHits {
  inTitle: boolean;
  headingHits: number;
  bodyHits: number;
}

interface DocMatch {
  doc: ParsedDoc;
  lines: string[];
  perTerm: Map<string, TermHits>;
  identifierHits: number;
  /** Line index → distinct terms matched there, for snippet selection. */
  lineTerms: Map<number, number>;
  /** Line indexes carrying a verbatim identifier match. */
  identifierLines: Set<number>;
}

/** Per-doc match collection. Scoring is deferred until corpus IDF is known. */
function collectMatches(terms: string[], identifiers: string[], doc: ParsedDoc): DocMatch | null {
  const titleLower = doc.entry.title.toLowerCase();
  const lines = doc.body.split("\n");
  const linesLower = lines.map((l) => l.toLowerCase());

  const perTerm = new Map<string, TermHits>();
  const lineTerms = new Map<number, number>();
  const identifierLines = new Set<number>();

  for (const term of terms) {
    const hits: TermHits = { inTitle: titleLower.includes(term), headingHits: 0, bodyHits: 0 };
    for (let i = 0; i < linesLower.length; i++) {
      if (!linesLower[i]?.includes(term)) continue;
      if ((lines[i] ?? "").trimStart().startsWith("#")) hits.headingHits++;
      else hits.bodyHits++;
      lineTerms.set(i, (lineTerms.get(i) ?? 0) + 1);
    }
    if (hits.inTitle || hits.headingHits > 0 || hits.bodyHits > 0) perTerm.set(term, hits);
  }

  let identifierHits = 0;
  for (const identifier of identifiers) {
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]?.includes(identifier)) continue;
      identifierLines.add(i);
      found = true;
    }
    if (found) identifierHits++;
  }

  if (perTerm.size === 0) return null;
  // A doc whose only evidence is its title is not about the query — every real
  // hit mentions the term somewhere in its body.
  const hasBodyEvidence = [...perTerm.values()].some((h) => h.headingHits > 0 || h.bodyHits > 0);
  if (!hasBodyEvidence && lines.some((line) => line.trim())) return null;

  return { doc, lines, perTerm, identifierHits, lineTerms, identifierLines };
}

/**
 * Inverse document frequency over the searched set. Without it every term
 * counts the same, so a common word repeated through a long doc buries the one
 * doc that actually defines the rare term the user asked about.
 */
function buildIdf(terms: string[], matches: DocMatch[], docCount: number): Map<string, number> {
  const idf = new Map<string, number>();
  for (const term of terms) {
    const df = matches.reduce((count, match) => count + (match.perTerm.has(term) ? 1 : 0), 0);
    idf.set(term, Math.log(1 + docCount / (1 + df)));
  }
  return idf;
}

/** Best few lines by distinct-term coverage, not the first few encountered. */
function pickSnippets(match: DocMatch): DocSearchSnippet[] {
  const candidates = new Set<number>([...match.lineTerms.keys(), ...match.identifierLines]);
  return [...candidates]
    .map((index) => {
      const termCount = match.lineTerms.get(index) ?? 0;
      const hasIdentifier = match.identifierLines.has(index);
      const isHeading = (match.lines[index] ?? "").trimStart().startsWith("#");
      // A heading earns its bonus only when it is genuinely on topic; otherwise
      // it loses ties to prose. When a query shares just one common word with a
      // doc, every heading used to tie with every prose line and outrank it on
      // the bonus, so the snippets degraded into a table of contents — measured
      // on "createTestContext move", which returned "# Moves", "### Per-Move
      // Dependencies", "### Harness Imports" and no information at all.
      // The off-topic adjustment is deliberately just a tie-breaker: a heading
      // should lose to an equally-matching prose line, never to a weaker one.
      const onTopic = termCount >= 2 || hasIdentifier;
      return {
        index,
        weight: termCount * 10
          + (hasIdentifier ? 6 : 0)
          + (isHeading ? (onTopic ? 2 : -1) : 0),
      };
    })
    .sort((a, b) => (b.weight - a.weight) || (a.index - b.index))
    .slice(0, SNIPPET_LIMIT)
    .sort((a, b) => a.index - b.index)
    .map(({ index }) => {
      const text = (match.lines[index] ?? "").trim();
      return {
        line: index + 1,
        text: text.length > SNIPPET_MAX_CHARS ? `${text.slice(0, SNIPPET_MAX_CHARS - 3)}...` : text,
      };
    });
}

/**
 * Sublinear term frequency. Forty mentions is not forty times the evidence of
 * one, and treating it that way is exactly how a long overview doc buries the
 * short doc that actually defines the thing.
 */
function saturate(hits: number): number {
  return hits > 0 ? 1 + Math.log(hits) : 0;
}

function scoreMatch(terms: string[], match: DocMatch, idf: Map<string, number>): DocSearchHit {
  let raw = 0;
  for (const [term, hits] of match.perTerm) {
    const tf = (hits.inTitle ? TITLE_WEIGHT : 0)
      + saturate(hits.headingHits) * HEADING_WEIGHT
      + saturate(hits.bodyHits) * BODY_WEIGHT;
    raw += tf * (idf.get(term) ?? 1);
  }
  raw += match.identifierHits * IDENTIFIER_WEIGHT;

  // Coverage rewards docs that answer the whole query; the second division
  // normalizes for query length so scores stay comparable across queries.
  const coverage = match.perTerm.size / terms.length;
  const score = Math.round((raw * coverage / terms.length) * 10) / 10;
  return { id: match.doc.entry.id, title: match.doc.entry.title, score, snippets: pickSnippets(match) };
}

// ── Generated: move-ops ──

interface MoveScanRoot {
  dir: string;
  origin: string;
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function buildMoveOpsBody(roots: MoveScanRoot[]): string {
  const lines: string[] = [
    "Generated inventory of every discoverable move and the surface it exposes:",
    "declared `api` ops (what an agent can call through `modus_submit`), execution",
    "mode, capabilities, and trust tier. Use this to audit that only approved ops",
    "are actually exposed. Regenerated on every read — never stale.",
    "",
  ];

  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    for (const dirent of readdirSync(root.dir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const config = readJsonSafe(join(root.dir, dirent.name, "move.json"));
      if (!config || typeof config.name !== "string") continue;

      const trust = typeof config.trust === "string"
        ? config.trust
        : root.origin === "harness" ? "builtin (inferred)" : "experimental (inferred)";
      const mode = config.persistent === true ? "persistent" : String(config.mode ?? "inline");

      lines.push(`## ${config.name} (${root.origin})`);
      if (typeof config.description === "string") lines.push(config.description);
      lines.push("");
      lines.push(`- mode: ${mode}`);
      lines.push(`- trust: ${trust}`);
      if (config.capabilities && typeof config.capabilities === "object") {
        lines.push(`- capabilities: \`${JSON.stringify(config.capabilities)}\``);
      } else {
        lines.push("- capabilities: undeclared (defaults: all allowed)");
      }
      const widget = config.widget as Record<string, unknown> | undefined;
      if (widget && typeof widget === "object") {
        lines.push(`- widget: ${String(widget.component ?? "?")} (label: ${String(widget.label ?? "?")})`);
      }
      const page = config.page as Record<string, unknown> | undefined;
      if (page && typeof page === "object") {
        lines.push(`- page: ${String(page.id ?? "?")} (title: ${String(page.title ?? "?")})`);
      }
      const api = config.api as { ops?: Record<string, { description?: string; schema?: unknown }> } | undefined;
      const ops = api?.ops && typeof api.ops === "object" ? Object.entries(api.ops) : [];
      if (ops.length) {
        lines.push("- api ops:");
        for (const [opName, op] of ops) {
          const schema = op && typeof op === "object" && op.schema ? "yes" : "no";
          const description = op && typeof op === "object" && typeof op.description === "string" ? op.description : "";
          lines.push(`  - \`${opName}\` — ${description} (schema: ${schema})`);
        }
      } else {
        lines.push("- api ops: none");
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

const MOVE_OPS_ID = "generated/move-ops";

function moveOpsEntry(): DocIndexEntry {
  return {
    id: MOVE_OPS_ID,
    title: "Move ops inventory (generated)",
    summary: "Every discoverable move with its declared api ops, mode, capabilities, and trust tier — the exposed-op audit surface.",
    audience: "dev",
    generated: true,
  };
}

// ── Registry ──

export function createDocsRegistry(config: { docsDir: string; builtinMovesDir?: string }): DocsRegistry {
  const docsRoot = resolve(config.docsDir);
  const cache = new Map<string, CacheSlot>();

  function loadDoc(id: string): ParsedDoc | null {
    const path = resolve(join(docsRoot, `${id}.md`));
    if (path !== docsRoot && !path.startsWith(docsRoot + sep)) return null;
    if (!existsSync(path)) return null;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return null;
    }
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) return cached.parsed;

    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return null;
    }
    const { meta, body } = parseFrontmatter(raw);
    const coversRaw = meta.covers?.trim() ?? "";
    const coversNone = coversRaw.toLowerCase() === "none";
    const parsed: ParsedDoc = {
      entry: {
        id,
        title: meta.title || id,
        summary: extractSummary(body),
        audience: normalizeAudience(meta.audience),
        lastUpdated: meta.lastUpdated || undefined,
        covers: coversRaw && !coversNone ? coversRaw.split(/\s+/).filter(Boolean) : undefined,
        ...(coversNone ? { coversNone: true } : {}),
      },
      body,
    };
    cache.set(path, { mtimeMs, parsed });
    return parsed;
  }

  function moveScanRoots(cwd?: string): MoveScanRoot[] {
    const roots: MoveScanRoot[] = [];
    if (config.builtinMovesDir) roots.push({ dir: config.builtinMovesDir, origin: "harness" });
    if (cwd) roots.push({ dir: join(cwd, ".modus", "moves"), origin: "project" });
    return roots;
  }

  function loadGenerated(id: string, opts?: DocsQueryOpts): ParsedDoc | null {
    if (id !== MOVE_OPS_ID) return null;
    return { entry: moveOpsEntry(), body: buildMoveOpsBody(moveScanRoots(opts?.cwd)) };
  }

  function allDocs(opts?: DocsQueryOpts): ParsedDoc[] {
    const docs: ParsedDoc[] = [];
    for (const id of walkMarkdownFiles(docsRoot).sort()) {
      // The virtual doc owns its id; a file of the same name would double it.
      if (id === MOVE_OPS_ID) continue;
      const doc = loadDoc(id);
      if (doc) docs.push(doc);
    }
    const generated = loadGenerated(MOVE_OPS_ID, opts);
    if (generated) docs.push(generated);
    return docs;
  }

  function matchesAudience(entry: DocIndexEntry, audience?: DocAudience | "all"): boolean {
    if (!audience || audience === "all") return true;
    return entry.audience === audience;
  }

  return {
    listDocs(opts?: DocsQueryOpts): DocIndexEntry[] {
      return allDocs(opts)
        .map((d) => d.entry)
        .filter((e) => matchesAudience(e, opts?.audience));
    },

    getDoc(id: string, opts?: DocsQueryOpts): DocContent | null {
      const clean = sanitizeDocId(id);
      if (!clean) return null;
      // Virtual first, then disk. Without the fall-through every build-time file
      // under docs/generated/ would be listed and searchable but unfetchable,
      // because loadGenerated only knows the virtual ids.
      const virtual = clean.startsWith("generated/") ? loadGenerated(clean, opts) : null;
      const doc = virtual ?? loadDoc(clean);
      if (!doc) return null;
      return { ...doc.entry, content: doc.body };
    },

    searchDocs(queries: string[], opts?: DocsSearchOpts): DocSearchResult[] {
      const limit = Math.min(Math.max(1, opts?.limit ?? 5), 20);
      const docs = allDocs(opts).filter((d) => matchesAudience(d.entry, opts?.audience));
      // Lowercased once for the whole batch: "does this appear anywhere at all"
      // is answered against the corpus, not against the docs that happened to
      // rank, so a negative is a fact rather than an artifact of scoring.
      const bodiesLower = docs.map((d) => d.body.toLowerCase());
      return queries.slice(0, 16).map((query) => {
        const terms = tokenizeQuery(query);
        const identifiers = extractIdentifiers(query);
        const missingTerms = terms.filter((term) => !bodiesLower.some((body) => body.includes(term)));
        const missingIdentifiers = identifiers.filter(
          (identifier) => !docs.some((d) => d.body.includes(identifier)),
        );
        if (!terms.length) return { query, results: [], missingTerms, missingIdentifiers };
        const matches = docs
          .map((doc) => collectMatches(terms, identifiers, doc))
          .filter((match): match is DocMatch => match !== null);
        const idf = buildIdf(terms, matches, docs.length);
        const results = matches
          .map((match) => scoreMatch(terms, match, idf))
          .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
          .slice(0, limit);
        return { query, results, missingTerms, missingIdentifiers };
      });
    },
  };
}

// ── Default instance (bound to the packaged/checkout resource layout) ──

let defaultRegistry: DocsRegistry | null = null;

function registry(): DocsRegistry {
  if (!defaultRegistry) {
    defaultRegistry = createDocsRegistry({
      docsDir: join(APP_PATHS.resourcesDir, "docs"),
      builtinMovesDir: join(APP_PATHS.resourcesDir, "moves"),
    });
  }
  return defaultRegistry;
}

export function listDocs(opts?: DocsQueryOpts): DocIndexEntry[] {
  return registry().listDocs(opts);
}

export function getDoc(id: string, opts?: DocsQueryOpts): DocContent | null {
  return registry().getDoc(id, opts);
}

export function searchDocs(queries: string[], opts?: DocsSearchOpts): DocSearchResult[] {
  return registry().searchDocs(queries, opts);
}
