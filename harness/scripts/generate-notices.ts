/**
 * Build-time generation of third-party license notices and a CycloneDX SBOM.
 *
 * Modus redistributes far more than its own Apache-2.0 source. The desktop
 * package ships a verbatim copy of the Bun runtime, two Rust executables, and
 * `server.js`/`cli.js`/`ui/dist` bundles that *inline the source text* of their
 * npm dependency trees. Every one of those carries an attribution obligation
 * that `LICENSE` alone does not satisfy.
 *
 * Scope is what actually ships, not what the lockfiles contain:
 *   - npm: the transitive closure of each workspace's `dependencies` only,
 *     walking `dependencies` and `optionalDependencies` (a platform variant of
 *     a shipped package still ships) plus non-optional `peerDependencies`.
 *     `devDependencies` are build tooling and reach no artifact.
 *   - cargo: the closure of the crate graph under `null` (normal) and `build`
 *     dependency kinds, restricted to edges whose `cfg` holds for the target.
 *     `dev` kinds build tests and benchmarks only, and a macOS-only crate is
 *     not in a Windows binary.
 *   - Neither closure is narrowed to what a bundler tree-shook. Over-inclusion
 *     attributes more than required; under-inclusion is the failure that
 *     matters.
 *
 * Platform matters. npm platform variants declare `os`/`cpu`, and only the
 * matching ones are installed and shipped, so the closure resolves against a
 * concrete target and the target is recorded in the output. Regenerate per
 * target when a macOS or Linux package becomes real.
 *
 * Nothing is ever silently dropped. A package whose license cannot be
 * determined throws by name and must be answered in `notices/overrides.json`
 * with the source it was read from. That is the discipline `stagePtyLibrary()`
 * applies to native artifacts: a green build that ships an incomplete notice is
 * the defect this file exists to prevent.
 *
 * Regenerate with `bun run notices:generate` from `harness/`. `notices.test.ts`
 * fails when the committed npm section drifts; the Rust section is verified in
 * CI's Rust job, the only one with a populated cargo registry.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

const HARNESS_DIR = join(import.meta.dir, "..");
const REPO_DIR = join(HARNESS_DIR, "..");
const NOTICES_DIR = join(HARNESS_DIR, "notices");
const CANONICAL_DIR = join(NOTICES_DIR, "licenses");

/**
 * The notices are a repository-root file rather than a doc under
 * `harness/docs/`. At well over a megabyte of license text they would be
 * lowercased line by line on every `docs_search` call (`collectMatches`) and
 * would outrank real documentation on common words like "software" and
 * "distribution". `harness/docs/third-party-notices.md` is the small,
 * searchable pointer; staging copies this file beside the packaged server.
 */
export const NOTICES_PATH = join(REPO_DIR, "THIRD-PARTY-NOTICES.md");
export const SBOM_PATH = join(REPO_DIR, "sbom.cdx.json");
export const INSTALLER_LICENSE_PATH = join(REPO_DIR, "desktop", "installer-license.txt");

/**
 * The npm workspaces whose runtime dependencies reach a shipped artifact.
 * `desktop/` is deliberately absent: its only dependency is the Tauri CLI,
 * which builds the package and is not part of it.
 */
const NPM_WORKSPACES: { lock: string; modules: string }[] = [
  { lock: "harness/bun.lock", modules: "harness/node_modules" },
  { lock: "harness/ui/bun.lock", modules: "harness/ui/node_modules" },
  { lock: "bun.lock", modules: "node_modules" },
];

/** Cargo manifests that produce a shipped executable. */
const CARGO_MANIFESTS = ["desktop/src-tauri/Cargo.toml", "desktop/cli-launcher/Cargo.toml"];

export type BuildTarget = { os: string; cpu: string };

/** The only target with a shipped package today; CI verifies on the same one. */
export const DEFAULT_TARGET: BuildTarget = { os: "win32", cpu: "x64" };

export type Component = {
  ecosystem: "npm" | "cargo" | "binary";
  name: string;
  version: string;
  /** The SPDX expression as declared upstream, before election. */
  declared: string;
  /** The licenses elected from `declared`; all of them apply. */
  elected: string[];
  /** License text blocks, in the order they should be reproduced. */
  texts: { title: string; body: string }[];
  homepage?: string;
  purl: string;
};

// ── SPDX expressions ──

/**
 * Preference order for electing one branch of an `OR`. Redistributing under the
 * most permissive offered license is the conventional choice and it keeps the
 * canonical-text set small; the notices record both what was declared and what
 * was elected, so the choice stays checkable.
 */
const ELECTION_ORDER = [
  "MIT",
  "MIT-0",
  "0BSD",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "Zlib",
  "Unlicense",
  "CC0-1.0",
  "BSL-1.0",
  "Unicode-3.0",
  "CDLA-Permissive-2.0",
  "MPL-2.0",
];

type SpdxNode =
  | { kind: "id"; id: string }
  | { kind: "and"; parts: SpdxNode[] }
  | { kind: "or"; parts: SpdxNode[] };

/** Cargo tolerates the pre-SPDX `A/B` form, so normalize it before parsing. */
function tokenizeSpdx(expression: string): string[] {
  return expression
    .replace(/\//g, " OR ")
    .replace(/([()])/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean);
}

function parseSpdx(expression: string): SpdxNode {
  const tokens = tokenizeSpdx(expression);
  let position = 0;

  function parseOr(): SpdxNode {
    const parts = [parseAnd()];
    while (tokens[position]?.toUpperCase() === "OR") {
      position += 1;
      parts.push(parseAnd());
    }
    return parts.length === 1 ? parts[0]! : { kind: "or", parts };
  }

  function parseAnd(): SpdxNode {
    const parts = [parseAtom()];
    while (tokens[position]?.toUpperCase() === "AND") {
      position += 1;
      parts.push(parseAtom());
    }
    return parts.length === 1 ? parts[0]! : { kind: "and", parts };
  }

  function parseAtom(): SpdxNode {
    const token = tokens[position];
    if (!token) throw new Error(`Unterminated SPDX expression: ${expression}`);
    position += 1;
    if (token === "(") {
      const inner = parseOr();
      if (tokens[position] !== ")") throw new Error(`Unbalanced parentheses in SPDX expression: ${expression}`);
      position += 1;
      return inner;
    }
    let id = token;
    if (tokens[position]?.toUpperCase() === "WITH") {
      id = `${id} WITH ${tokens[position + 1] ?? ""}`.trim();
      position += 2;
    }
    return { kind: "id", id };
  }

  const parsed = parseOr();
  if (position !== tokens.length) throw new Error(`Trailing tokens in SPDX expression: ${expression}`);
  return parsed;
}

function rank(id: string): number {
  const index = ELECTION_ORDER.indexOf(id);
  return index === -1 ? ELECTION_ORDER.length : index;
}

/** Collapse an SPDX expression to the set of licenses we redistribute under. */
export function electLicenses(expression: string): string[] {
  function walk(node: SpdxNode): string[] {
    if (node.kind === "id") return [node.id];
    if (node.kind === "and") return node.parts.flatMap(walk);
    const branches = node.parts.map(walk);
    let best = branches[0]!;
    for (const branch of branches.slice(1)) {
      if (Math.min(...branch.map(rank)) < Math.min(...best.map(rank))) best = branch;
    }
    return best;
  }
  return [...new Set(walk(parseSpdx(expression)))];
}

// ── Overrides ──

type LicenseOverride = {
  spdx: string;
  /** Where the license was read from, so the exception stays checkable. */
  source: string;
  /** Verbatim terms, for a component whose license lives somewhere unscannable. */
  text?: string;
};

const overrides = JSON.parse(readFileSync(join(NOTICES_DIR, "overrides.json"), "utf-8")) as Record<
  string,
  LicenseOverride
>;

/**
 * Upstream metadata is the source of truth; an override is the auditable
 * exception for a component that publishes no usable license field, or one
 * whose field is not an SPDX expression at all (`Public Domain`,
 * `SEE LICENSE IN ...`). Every entry records the evidence it was read from.
 */
function declaredLicense(key: string, upstream: string | undefined, hint: string): string {
  const override = overrides[key];
  if (override) return override.spdx;
  if (upstream?.trim()) return upstream.trim();
  throw new Error(
    `No license declared for ${key} (${hint}). Read its published license and add an entry to `
      + "harness/notices/overrides.json with the SPDX expression and the source it was read from.",
  );
}

// ── Installed but not redistributed ──

/**
 * Bundling inlines JavaScript, so a package whose only payload is a native
 * binary reaches the package only if staging copies it by name. Listing one of
 * those as shipped would claim a redistribution that never happens — and for a
 * proprietary binary that is a materially false statement, not merely a
 * conservative over-inclusion.
 *
 * The list is deliberately hand-maintained and evidence-bearing: which files a
 * bundler emits cannot be derived from a lockfile, and the generator must not
 * depend on a build having run. `notices.test.ts` fails on a stale entry, so an
 * exclusion that stops applying is a red test rather than a silent omission.
 */
export const NOT_REDISTRIBUTED = Object.fromEntries(
  Object.entries(
    JSON.parse(readFileSync(join(NOTICES_DIR, "not-redistributed.json"), "utf-8")) as Record<
      string,
      { reason: string; evidence: string }
    >,
  ).filter(([key]) => !key.startsWith("_")),
);

export function partitionRedistributed(components: Component[]): {
  shipped: Component[];
  excluded: Component[];
} {
  const shipped: Component[] = [];
  const excluded: Component[] = [];
  for (const component of components) {
    (NOT_REDISTRIBUTED[`${component.name}@${component.version}`] ? excluded : shipped).push(component);
  }
  return { shipped, excluded };
}

// ── License text ──

const LICENSE_FILE = /^(licen[cs]e|copying|unlicen[cs]e|notice)([-._].*)?$/i;

function licenseFilesIn(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const canonicalCache = new Map<string, string>();

/**
 * Canonical text for a license whose component publishes none. Throws by name
 * so a new license in the tree is a build failure with an obvious fix, rather
 * than a notice entry that quietly says nothing.
 */
function canonicalText(id: string): string {
  const cached = canonicalCache.get(id);
  if (cached !== undefined) return cached;
  const path = join(CANONICAL_DIR, `${id.replace(/[^A-Za-z0-9.-]/g, "_")}.txt`);
  if (!existsSync(path)) {
    throw new Error(
      `No canonical text for ${id} at ${path}. Add the official license text there: at least one `
        + `shipped component declares ${id} without publishing the text itself.`,
    );
  }
  const text = readFileSync(path, "utf-8").replace(/\r\n/g, "\n").trimEnd();
  canonicalCache.set(id, text);
  return text;
}

function readText(path: string): string {
  return readFileSync(path, "utf-8").replace(/\r\n/g, "\n").trimEnd();
}

/**
 * Reproduce the component's own license text wherever it publishes one, because
 * a permissive license requires reproducing *its* copyright line, not a
 * template. Fall back to canonical text plus an attribution derived from
 * package metadata only when nothing was published.
 */
function licenseTexts(
  key: string,
  directory: string,
  elected: string[],
  attribution: string,
): { title: string; body: string }[] {
  const override = overrides[key];
  if (override?.text) {
    return [{ title: `${override.spdx} — quoted from ${override.source}`, body: override.text }];
  }
  const files = licenseFilesIn(directory);
  if (files.length === 0) {
    return elected.map((id) => ({
      title: `${id} — text not published by this component; attribution derived from its package metadata`,
      body: `${attribution}\n\n${canonicalText(id)}`,
    }));
  }
  if (files.length === 1) {
    return [{ title: elected.join(" AND "), body: readText(join(directory, files[0]!)) }];
  }
  // Several files means the component published one per license. Take the ones
  // matching what we elected; if no filename carries a license id we recognize,
  // reproduce all of them rather than guess.
  const matched = elected.flatMap((id) => {
    const needle = normalizeForMatch(id.replace(/ WITH .*/, ""));
    const file = files.find((name) => normalizeForMatch(name).includes(needle));
    return file ? [{ title: id, body: readText(join(directory, file)) }] : [];
  });
  if (matched.length > 0) return matched;
  return files.map((name) => ({
    title: `${elected.join(" AND ")} (${name})`,
    body: readText(join(directory, name)),
  }));
}

// ── npm ──

type BunLock = {
  workspaces: Record<string, { dependencies?: Record<string, string> }>;
  packages: Record<string, unknown[]>;
};

type PackageMeta = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalPeers?: string[];
  os?: string | string[];
  cpu?: string | string[];
};

/** `bun.lock` is JSONC with trailing commas; Bun writes it and nothing parses it for us. */
function readBunLock(path: string): BunLock {
  return JSON.parse(readFileSync(path, "utf-8").replace(/,(\s*[}\]])/g, "$1")) as BunLock;
}

function platformMatches(values: string | string[] | undefined, actual: string): boolean {
  if (!values) return true;
  const list = Array.isArray(values) ? values : [values];
  if (list.length === 0) return true;
  if (list.every((value) => value.startsWith("!"))) return !list.includes(`!${actual}`);
  return list.includes(actual);
}

/**
 * Lock keys are `name` at the top level and `parent/name` where a nested
 * resolution differs, mirroring node resolution. Walk outward from the
 * requesting key exactly as the runtime would.
 */
function resolveKey(packages: BunLock["packages"], from: string, name: string): string | null {
  const segments = from ? from.split("/") : [];
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const candidate = [...segments.slice(0, depth), name].join("/");
    if (packages[candidate]) return candidate;
  }
  return packages[name] ? name : null;
}

export function collectNpmComponents(target: BuildTarget = DEFAULT_TARGET): Component[] {
  const components = new Map<string, Component>();

  for (const workspace of NPM_WORKSPACES) {
    const lock = readBunLock(join(REPO_DIR, workspace.lock));
    const modulesDir = join(REPO_DIR, workspace.modules);
    const queue: { key: string; optional: boolean }[] = [];
    for (const root of Object.keys(lock.workspaces[""]?.dependencies ?? {})) {
      const key = resolveKey(lock.packages, "", root);
      if (!key) throw new Error(`${workspace.lock} declares ${root} but the lock has no entry for it`);
      queue.push({ key, optional: false });
    }

    const visited = new Set<string>();
    while (queue.length > 0) {
      const { key, optional } = queue.pop()!;
      if (visited.has(key)) continue;
      const entry = lock.packages[key];
      if (!entry) throw new Error(`${workspace.lock} has no entry for ${key}`);
      const spec = entry[0] as string;
      const meta = (entry[2] ?? {}) as PackageMeta;

      if (!platformMatches(meta.os, target.os) || !platformMatches(meta.cpu, target.cpu)) continue;

      const name = spec.slice(0, spec.lastIndexOf("@"));
      const version = spec.slice(spec.lastIndexOf("@") + 1);
      const directory = join(modulesDir, ...name.split("/"));
      if (!existsSync(directory)) {
        // An optional dependency Bun chose not to install cannot be bundled, so
        // it ships nothing. A required one missing means the tree is not
        // installed, and generating from it would understate the notice.
        if (optional) continue;
        throw new Error(
          `${name}@${version} is a required dependency of ${workspace.lock} but is not installed at `
            + `${directory}. Run \`bun install --frozen-lockfile\` for that workspace first.`,
        );
      }
      visited.add(key);

      for (const group of ["dependencies", "optionalDependencies"] as const) {
        for (const dependency of Object.keys(meta[group] ?? {})) {
          const resolved = resolveKey(lock.packages, key, dependency);
          if (resolved) queue.push({ key: resolved, optional: group === "optionalDependencies" });
        }
      }
      // A peer is supplied by the host, so treat it as optional for presence:
      // an unresolved peer is not installed and therefore ships nothing.
      const optionalPeers = new Set(meta.optionalPeers ?? []);
      for (const dependency of Object.keys(meta.peerDependencies ?? {})) {
        if (optionalPeers.has(dependency)) continue;
        const resolved = resolveKey(lock.packages, key, dependency);
        if (resolved) queue.push({ key: resolved, optional: true });
      }

      const identifier = `${name}@${version}`;
      if (components.has(identifier)) continue;
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf-8")) as {
        license?: string | { type?: string };
        licenses?: { type?: string }[];
        homepage?: string;
        author?: string | { name?: string };
        repository?: string | { url?: string };
      };
      const upstream = typeof manifest.license === "string"
        ? manifest.license
        : manifest.license?.type
          ?? manifest.licenses?.map((entry) => entry.type).filter(Boolean).join(" OR ");
      const declared = declaredLicense(identifier, upstream, `npm package in ${workspace.modules}`);
      const elected = electLicenses(declared);
      const author = typeof manifest.author === "string" ? manifest.author : manifest.author?.name;
      const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
      components.set(identifier, {
        ecosystem: "npm",
        name,
        version,
        declared,
        elected,
        texts: licenseTexts(identifier, directory, elected, `Copyright (c) ${author ?? `the ${name} authors`}`),
        homepage: normalizeHomepage(manifest.homepage ?? repository),
        purl: npmPurl(name, version),
      });
    }
  }

  return [...components.values()].sort(compareComponents);
}

function normalizeHomepage(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "");
}

function npmPurl(name: string, version: string): string {
  const scoped = name.startsWith("@");
  const scope = scoped ? name.slice(0, name.indexOf("/")) : null;
  const bare = scoped ? name.slice(name.indexOf("/") + 1) : name;
  const namespace = scope ? `${encodeURIComponent(scope)}/` : "";
  return `pkg:npm/${namespace}${encodeURIComponent(bare)}@${version}`;
}

// ── cargo ──

type CargoMetadata = {
  packages: {
    id: string;
    name: string;
    version: string;
    license?: string | null;
    manifest_path: string;
    authors?: string[];
    repository?: string | null;
    homepage?: string | null;
  }[];
  resolve: {
    root: string | null;
    nodes: {
      id: string;
      deps: { pkg: string; dep_kinds: { kind: string | null; target?: string | null }[] }[];
    }[];
  };
};

/**
 * Cargo facts for the target being packaged. A dependency edge carries the
 * `cfg` it applies under, and an edge that does not apply contributes no code
 * to this platform's binary.
 *
 * Filtering matters twice over. It stops the Windows notices from claiming to
 * ship macOS Cocoa bindings, and it removes a determinism hole: a crate that
 * never applies here is also never unpacked into the local registry, so its
 * license text resolves differently on a machine that happens to have fetched
 * it — which would make the drift check fail for no real reason.
 */
const CARGO_CFG: Record<string, string> = {
  target_os: "windows",
  target_family: "windows",
  target_arch: "x86_64",
  target_env: "msvc",
  target_vendor: "pc",
  target_pointer_width: "64",
  target_endian: "little",
};
const CARGO_TRIPLE = "x86_64-pc-windows-msvc";

/**
 * Evaluate a cargo dependency `target` expression. Unknown predicates evaluate
 * true: over-inclusion attributes more than required, while a wrong `false`
 * would drop a component that really ships.
 */
export function cargoTargetApplies(target: string | null | undefined): boolean {
  if (!target) return true;
  const expression = target.trim();
  if (!expression.startsWith("cfg(")) return expression === CARGO_TRIPLE;

  let position = 0;
  const source = expression.slice(4, -1);

  function skipSpace(): void {
    while (source[position] === " " || source[position] === ",") position += 1;
  }

  function parseList(): boolean[] {
    const values: boolean[] = [];
    position += 1; // consume "("
    for (;;) {
      skipSpace();
      if (source[position] === ")" || position >= source.length) {
        position += 1;
        return values;
      }
      values.push(parseTerm());
    }
  }

  function parseTerm(): boolean {
    skipSpace();
    const start = position;
    while (position < source.length && /[A-Za-z0-9_]/.test(source[position]!)) position += 1;
    const word = source.slice(start, position);
    skipSpace();

    if (source[position] === "(") {
      const values = parseList();
      if (word === "all") return values.every(Boolean);
      if (word === "any") return values.some(Boolean);
      if (word === "not") return !values[0];
      return true;
    }
    if (source[position] === "=") {
      position += 1;
      skipSpace();
      const quote = source.indexOf('"', position);
      const close = source.indexOf('"', quote + 1);
      const value = source.slice(quote + 1, close);
      position = close + 1;
      const known = CARGO_CFG[word];
      return known === undefined ? true : known === value;
    }
    if (word === "windows") return CARGO_CFG.target_family === "windows";
    if (word === "unix") return CARGO_CFG.target_family === "unix";
    return true;
  }

  return parseTerm();
}

/**
 * `--locked --offline` keeps this reproducible and network-free. The registry
 * is populated wherever the crate graph has been built, which is also the only
 * place per-crate license text exists.
 *
 * `--filter-platform` is what makes `--offline` viable. Unfiltered, cargo
 * resolves every platform's dependencies and must have each one present to
 * describe it — including crates a Windows build never downloads, such as
 * `android_system_properties`. A machine that happens to have fetched them
 * succeeds while a build-only registry fails, which is a green local run and a
 * red CI one. Filtering to the shipped triple asks only for what was built.
 *
 * This narrows the same closure `cargoTargetApplies()` narrows, from the same
 * constant, so the two cannot disagree about which target is being described.
 */
function cargoMetadata(manifest: string): CargoMetadata {
  const result = Bun.spawnSync(
    [
      "cargo",
      "metadata",
      "--manifest-path",
      join(REPO_DIR, manifest),
      "--format-version",
      "1",
      "--locked",
      "--offline",
      "--filter-platform",
      CARGO_TRIPLE,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`cargo metadata failed for ${manifest}:\n${result.stderr.toString()}`);
  }
  return JSON.parse(result.stdout.toString()) as CargoMetadata;
}

export function collectCargoComponents(): Component[] {
  const components = new Map<string, Component>();

  for (const manifest of CARGO_MANIFESTS) {
    const metadata = cargoMetadata(manifest);
    const root = metadata.resolve.root;
    if (!root) throw new Error(`${manifest} resolves no root package`);
    const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
    const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));

    const visited = new Set<string>();
    const queue = [root];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const dependency of nodes.get(id)?.deps ?? []) {
        // `dev` kinds build tests and benchmarks; nothing they pull in is
        // linked into a shipped executable. `build` kinds can emit code that is.
        // A `cfg` that does not hold for this target contributes nothing either.
        const applies = dependency.dep_kinds.some(
          (kind) => (kind.kind === null || kind.kind === "build") && cargoTargetApplies(kind.target),
        );
        if (applies) queue.push(dependency.pkg);
      }
    }
    visited.delete(root);

    for (const id of visited) {
      const pkg = packages.get(id);
      if (!pkg) throw new Error(`${manifest} resolves ${id} but cargo metadata has no package for it`);
      const identifier = `${pkg.name}@${pkg.version}`;
      if (components.has(identifier)) continue;
      const declared = declaredLicense(identifier, pkg.license ?? undefined, `crate in ${manifest}`);
      const elected = electLicenses(declared);
      const attribution = `Copyright (c) ${pkg.authors?.length ? pkg.authors.join(", ") : `the ${pkg.name} authors`}`;
      components.set(identifier, {
        ecosystem: "cargo",
        name: pkg.name,
        version: pkg.version,
        declared,
        elected,
        texts: licenseTexts(identifier, dirname(pkg.manifest_path), elected, attribution),
        homepage: pkg.repository ?? pkg.homepage ?? undefined,
        purl: `pkg:cargo/${pkg.name}@${pkg.version}`,
      });
    }
  }

  return [...components.values()].sort(compareComponents);
}

function compareComponents(a: Component, b: Component): number {
  return a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en");
}

// ── Redistributed runtimes ──

/**
 * The Bun version the desktop package redistributes, read from the one place
 * that already pins it. `stage-managed-backend.ts` enforces that the binary it
 * copies reports this version, so the vendored license always describes the
 * runtime that actually ships.
 */
export function pinnedBunVersion(): string {
  const root = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf-8")) as { packageManager?: string };
  const match = /^bun@(\d+\.\d+\.\d+)$/.exec(root.packageManager ?? "");
  if (!match) {
    throw new Error(`Root package.json must pin "packageManager": "bun@<x.y.z>"; found ${root.packageManager}`);
  }
  return match[1]!;
}

export const VENDORED_BUN_LICENSE = join(REPO_DIR, "desktop", "third-party", "bun", "LICENSE.md");

/** Marks which upstream release the vendored aggregate notice was taken from. */
export function bunLicenseStamp(version: string): string {
  return `<!-- bun-version: ${version} -->`;
}

/**
 * Bun is not an npm dependency — it is a whole runtime copied into the package
 * as a sidecar, and it statically embeds JavaScriptCore, zlib, BoringSSL,
 * libarchive, mimalloc and more. Upstream publishes one aggregated LICENSE.md
 * covering exactly that set, so it is vendored verbatim rather than re-derived
 * from a dependency graph we cannot see.
 */
export function collectBinaryComponents(): Component[] {
  const version = pinnedBunVersion();
  const body = readText(VENDORED_BUN_LICENSE);
  const stamp = bunLicenseStamp(version);
  if (!body.includes(stamp)) {
    throw new Error(
      `${VENDORED_BUN_LICENSE} is not stamped for Bun ${version}. The pinned runtime changed: re-fetch `
        + `LICENSE.md from https://github.com/oven-sh/bun at tag bun-v${version} and update the stamp.`,
    );
  }
  return [
    {
      ecosystem: "binary",
      name: "bun",
      version,
      declared: "MIT AND LGPL-2.1-or-later AND BSD-2-Clause AND BSD-3-Clause AND Zlib AND Apache-2.0",
      elected: [],
      texts: [{ title: "Bun aggregated license notice", body: body.replace(stamp, "").trim() }],
      homepage: "https://github.com/oven-sh/bun",
      purl: `pkg:generic/bun@${version}`,
    },
  ];
}

// ── Rendering ──

function sectionMarkers(name: string): { begin: string; end: string } {
  return { begin: `<!-- BEGIN SECTION: ${name} -->`, end: `<!-- END SECTION: ${name} -->` };
}

/**
 * Extract one generated section. The npm and cargo halves are verified in
 * different CI jobs because only one of them has the inputs, so each check
 * compares its own slice rather than the whole file.
 */
export function extractSection(markdown: string, name: string): string {
  const { begin, end } = sectionMarkers(name);
  const start = markdown.indexOf(begin);
  const finish = markdown.indexOf(end);
  if (start === -1 || finish === -1) throw new Error(`No "${name}" section in the notices document`);
  return markdown.slice(start, finish + end.length);
}

/**
 * Identical license text is reproduced once per section and referenced by
 * label. Verbatim reproduction is the obligation, not verbatim *repetition*:
 * the Apache-2.0 text carries no per-component copyright line, so emitting it
 * beside all 122 crates that elect it added over a megabyte that said nothing
 * the first copy had not. Permissive licenses that do carry a copyright line
 * differ per component and pool naturally into one entry each.
 *
 * The pool is per section, not per document, so each section stays
 * independently regenerable — which is what lets the npm and cargo halves be
 * verified by different CI jobs.
 */
type PooledText = { label: string; title: string; body: string; users: string[] };

function textPool(prefix: string) {
  const byBody = new Map<string, PooledText>();
  return {
    /** Intern a text block and record which component it applies to. */
    intern(text: { title: string; body: string }, user: string): PooledText {
      let entry = byBody.get(text.body);
      if (!entry) {
        entry = { label: `${prefix}-${String(byBody.size + 1).padStart(4, "0")}`, title: text.title, body: text.body, users: [] };
        byBody.set(text.body, entry);
      }
      entry.users.push(user);
      return entry;
    },
    entries: (): PooledText[] => [...byBody.values()],
  };
}

function componentEntry(component: Component, pool: ReturnType<typeof textPool>): string[] {
  const facts = [`- License: \`${component.declared}\``];
  const elected = component.elected.join(" AND ");
  if (elected && elected !== component.declared) facts.push(`- Redistributed under: \`${elected}\``);
  if (component.homepage) facts.push(`- Source: ${component.homepage}`);
  const user = `${component.name} ${component.version}`;
  for (const text of component.texts) {
    facts.push(`- License text: **${pool.intern(text, user).label}** — ${text.title}`);
  }
  return [`### ${user}`, "", ...facts, ""];
}

function renderSection(
  name: string,
  heading: string,
  preamble: string[],
  components: Component[],
  trailer: string[] = [],
): string[] {
  const { begin, end } = sectionMarkers(name);
  const pool = textPool(name.slice(0, 3).toUpperCase());
  const componentEntries = components.flatMap((component) => componentEntry(component, pool));
  const texts = pool.entries();
  return [
    begin,
    "",
    heading,
    "",
    ...preamble,
    "",
    `${components.length} component${components.length === 1 ? "" : "s"}, under `
      + `${texts.length} distinct license text${texts.length === 1 ? "" : "s"}.`,
    "",
    ...componentEntries,
    `${heading} — license texts`,
    "",
    "Each block is reproduced verbatim. The component entries above name the block that",
    "applies to them by label.",
    "",
    ...texts.flatMap((entry) => [
      `### ${entry.label} — ${entry.title}`,
      "",
      `Applies to ${entry.users.length} component${entry.users.length === 1 ? "" : "s"}: ${entry.users.join(", ")}.`,
      "",
      "```text",
      entry.body,
      "```",
      "",
    ]),
    ...trailer,
    end,
  ];
}

export function renderNotices(input: {
  target: BuildTarget;
  npm: Component[];
  cargo: Component[];
  binary: Component[];
}): string {
  const npm = partitionRedistributed(input.npm);
  const lines = [
    "<!-- GENERATED FILE — do not edit. Run `bun run notices:generate` from harness/. Drift fails notices.test.ts. -->",
    "",
    "# Third-Party Notices",
    "",
    "Modus itself is licensed under Apache-2.0 (see `LICENSE`). The desktop package also",
    "redistributes the components below, each under its own license, and this file reproduces",
    "the notices those licenses require.",
    "",
    "It covers what the package **ships**, not everything in the lockfiles: build-only tooling",
    "reaches no artifact and is excluded. The set is resolved for the",
    `\`${input.target.os}-${input.target.cpu}\` target, because platform-specific native packages are only`,
    "installed and shipped for the target being built.",
    "",
    "Where a component publishes its own license text, that text is reproduced verbatim. Where",
    "it publishes only an SPDX identifier, the canonical license text is reproduced with an",
    "attribution derived from its package metadata, and the entry says so. Where a component",
    "offers a choice of licenses, the most permissive is elected, and both the declared",
    "expression and the elected license are recorded.",
    "",
    "A machine-readable inventory of the same components is `sbom.cdx.json`, beside this file.",
    "",
    ...renderSection("binaries", "## Redistributed runtimes", [
      "Shipped as whole binaries beside the application rather than as source dependencies.",
    ], input.binary),
    "",
    ...renderSection("javascript", "## JavaScript components", [
      "The desktop package does not ship `node_modules`. These dependencies are inlined as source",
      "into the bundled `server.js`, `cli.js`, workers, and `ui/dist`, so their code is distributed",
      "verbatim.",
    ], npm.shipped, npm.excluded.length === 0 ? [] : [
      "## Installed but not redistributed",
      "",
      "Present in the development tree and reachable from a shipped dependency, but absent from",
      "the package. Bundling inlines JavaScript; a package whose only payload is a native binary",
      "reaches the package only if staging copies it by name, and these are not copied.",
      "",
      ...npm.excluded.flatMap((component) => [
        `- **${component.name} ${component.version}** — `
          + `${NOT_REDISTRIBUTED[`${component.name}@${component.version}`]!.reason}`,
      ]),
      "",
    ]),
    "",
    ...renderSection("rust", "## Rust components", [
      "Statically linked into the Tauri desktop shell and the `modus` launcher sidecar.",
    ], input.cargo),
    "",
    "## Platform components not redistributed",
    "",
    "On Windows the application renders through Microsoft Edge WebView2, a system component",
    "installed and updated by the operating system. Modus does not redistribute the WebView2",
    "runtime; it links the loader published in the WebView2 SDK, whose terms accompany the",
    "`webview2-com-sys` crate above.",
    "",
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * CycloneDX 1.6. `serialNumber` and `metadata.timestamp` are deliberately
 * omitted: both change on every run and would make a committed SBOM impossible
 * to drift-check. The release-time SBOM that carries artifact hashes is produced
 * separately during packaging, and that one is timestamped.
 */
export function renderSbom(input: { target: BuildTarget; components: Component[] }): string {
  const { version } = JSON.parse(readFileSync(join(HARNESS_DIR, "version.json"), "utf-8")) as { version: string };
  const document = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": `pkg:generic/modus@${version}`,
        name: "Modus",
        version,
        licenses: [{ license: { id: "Apache-2.0" } }],
        purl: `pkg:generic/modus@${version}`,
      },
      properties: [{ name: "modus:target", value: `${input.target.os}-${input.target.cpu}` }],
    },
    components: partitionRedistributed(input.components).shipped.map((component) => ({
      type: component.ecosystem === "binary" ? "application" : "library",
      "bom-ref": component.purl,
      name: component.name,
      version: component.version,
      purl: component.purl,
      licenses: [{ expression: component.declared }],
      ...(component.homepage ? { externalReferences: [{ type: "website", url: component.homepage }] } : {}),
    })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * What the installer shows on its license page. Pointing `bundle.licenseFile`
 * straight at `LICENSE` presented Apache-2.0 as the whole story for a package
 * that embeds a thousand third-party components — accurate about Modus, wrong
 * about the artifact.
 */
export function renderInstallerLicense(): string {
  return [
    readText(join(REPO_DIR, "LICENSE")),
    "",
    "",
    "-------------------------------------------------------------------------------",
    "",
    "THIRD-PARTY COMPONENTS",
    "",
    "This package also includes third-party components licensed separately from Modus,",
    "including the Bun JavaScript runtime and the open-source libraries compiled into",
    "the application.",
    "",
    "The complete notices, with the full text of every applicable license, are installed",
    "with the application as:",
    "",
    "    modus\\THIRD-PARTY-NOTICES.md",
    "",
    "and accompany the source distribution as THIRD-PARTY-NOTICES.md.",
    "",
  ].join("\n");
}

/** The repo stores LF in the index but checks out CRLF on Windows. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Every component in the committed SBOM whose purl names this ecosystem. */
export function sbomComponentsFor(sbom: string, purlPrefix: string): unknown[] {
  const parsed = JSON.parse(sbom) as { components: { purl: string }[] };
  return parsed.components.filter((component) => component.purl.startsWith(purlPrefix));
}

// ── Entry point ──

/**
 * `--check <section>` regenerates one half and compares it against what is
 * committed. The halves are split because only CI's Rust job has a populated
 * cargo registry and only the Bun job has `node_modules`; each verifies the
 * inputs it actually has rather than skipping quietly.
 */
function check(section: "javascript" | "rust"): void {
  const target = DEFAULT_TARGET;
  const committedNotices = normalizeEol(readFileSync(NOTICES_PATH, "utf-8"));
  const committedSbom = readFileSync(SBOM_PATH, "utf-8");

  const components = section === "rust" ? collectCargoComponents() : collectNpmComponents(target);
  const rendered = renderNotices({
    target,
    npm: section === "javascript" ? components : [],
    cargo: section === "rust" ? components : [],
    binary: [],
  });

  const problems: string[] = [];
  if (extractSection(rendered, section) !== extractSection(committedNotices, section)) {
    problems.push(`the "${section}" section of THIRD-PARTY-NOTICES.md`);
  }
  const purlPrefix = section === "rust" ? "pkg:cargo/" : "pkg:npm/";
  const expected = JSON.parse(renderSbom({ target, components })).components;
  if (JSON.stringify(expected) !== JSON.stringify(sbomComponentsFor(committedSbom, purlPrefix))) {
    problems.push(`the ${purlPrefix} components of sbom.cdx.json`);
  }

  if (problems.length > 0) {
    console.error(
      `Third-party notices are stale: ${problems.join(" and ")} no longer match the dependency graph.\n`
        + "Run `bun run notices:generate` from harness/ and commit the result.",
    );
    process.exit(1);
  }
  console.log(`notices: "${section}" section matches the dependency graph (${components.length} components)`);
}

function main(): void {
  const checkIndex = process.argv.indexOf("--check");
  if (checkIndex !== -1) {
    const section = process.argv[checkIndex + 1];
    if (section !== "javascript" && section !== "rust") {
      throw new Error("Usage: generate-notices.ts --check <javascript|rust>");
    }
    check(section);
    return;
  }

  const target = DEFAULT_TARGET;
  const npm = collectNpmComponents(target);
  const cargo = collectCargoComponents();
  const binary = collectBinaryComponents();

  writeFileSync(NOTICES_PATH, renderNotices({ target, npm, cargo, binary }), "utf-8");
  writeFileSync(SBOM_PATH, renderSbom({ target, components: [...binary, ...npm, ...cargo] }), "utf-8");
  writeFileSync(INSTALLER_LICENSE_PATH, renderInstallerLicense(), "utf-8");

  console.log(
    `generated THIRD-PARTY-NOTICES.md (${binary.length} runtime, ${npm.length} npm, ${cargo.length} cargo)`,
  );
  console.log("generated sbom.cdx.json");
  console.log("generated desktop/installer-license.txt");
}

if (import.meta.main) main();
