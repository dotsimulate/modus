/**
 * Skills — packaged text an agent can load on demand.
 *
 * Modus is aware of skills; it does not own them. A skill is a directory
 * containing `SKILL.md` with front-matter carrying at least `name` and
 * `description`. That layout is deliberately the same one Claude-family CLIs
 * and PI already read, so a skill authored here stays usable outside Modus.
 *
 * Installed locations, most specific first:
 *   <project>/.modus/skills/<name>/SKILL.md
 *   ~/.modus/skills/<name>/SKILL.md
 *   <plugin>/.modus/skills/<name>/SKILL.md
 *
 * Move-bundled skills live at `<move>/skills/<name>/SKILL.md` and are not
 * installed — they reach an agent only when the move is attached, so they are
 * discovered per move rather than listed globally.
 *
 * Installed does not mean available: something must attach a skill before an
 * agent sees it. Attachment lives in `skill-attachment.ts`.
 *
 * Modus never scans, copies into, or overrides a provider's own skill
 * directories (`.claude/skills/`, `.pi/skills/`). Those keep working untouched.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homeSkillsDir } from "./modus-home";
import { listEnabledModusPlugins, getPluginSkillsDir, type ModusPlugin } from "./modus-plugins";

const PROJECT_SKILLS_DIR = ".modus/skills";
const MOVE_SKILLS_DIR = "skills";
const SKILL_FILE = "SKILL.md";

export type SkillOrigin = "project" | "user" | "plugin" | "move";

export type SkillDefinition = {
  /** Canonical name — always the directory name, never the front-matter value. */
  name: string;
  description: string;
  /** Directory holding SKILL.md. Returned to agents as the base for `references/*` reads. */
  dir: string;
  path: string;
  origin: SkillOrigin;
  pluginId?: string;
  moveName?: string;
  /** Remaining front-matter, passed through untouched so provider-specific keys survive. */
  meta: Record<string, string>;
};

// ── Front-matter ──

function stripQuotes(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse SKILL.md front-matter.
 *
 * Deliberately not the flat parser in `docs-registry.ts`: real skills use YAML
 * block scalars (`description: >` continued on indented lines), and a flat
 * `key: value` split misreads any continuation line containing a colon as a new
 * key. Handles top-level scalars, quoted values, and folded/literal blocks —
 * which is all the format actually uses. Not a general YAML parser.
 */
export function parseSkillFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: raw };
  const header = raw.slice(raw.indexOf("\n") + 1, end);
  const bodyStart = raw.indexOf("\n", end + 1);
  const body = bodyStart === -1 ? "" : raw.slice(bodyStart + 1);

  const meta: Record<string, string> = {};
  const lines = header.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    if (/^\s/.test(line)) continue; // indented — belongs to a block scalar we already consumed
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (!key) continue;
    let value = line.slice(sep + 1).trim();

    if (/^[|>][-+]?$/.test(value)) {
      const folded = value.startsWith(">");
      const collected: string[] = [];
      while (i + 1 < lines.length && (!lines[i + 1]!.trim() || /^\s/.test(lines[i + 1]!))) {
        collected.push(lines[++i]!.trim());
      }
      value = folded
        ? collected.join(" ").replace(/\s+/g, " ").trim()
        : collected.join("\n").trim();
    } else {
      value = stripQuotes(value);
    }
    meta[key] = value;
  }
  return { meta, body };
}

// ── Reading ──

/** Read one skill directory. Returns null when there is no readable SKILL.md. */
export function readSkillDir(
  dir: string,
  name: string,
  origin: SkillOrigin,
  extra: { pluginId?: string; moveName?: string } = {},
): SkillDefinition | null {
  const path = join(dir, SKILL_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const { meta } = parseSkillFrontmatter(raw);
  const { name: _frontmatterName, description, ...rest } = meta;
  return {
    name, // directory name is canonical, matching how moves resolve
    description: description ?? "",
    dir,
    path,
    origin,
    ...(extra.pluginId ? { pluginId: extra.pluginId } : {}),
    ...(extra.moveName ? { moveName: extra.moveName } : {}),
    meta: rest,
  };
}

/** Read the full SKILL.md text for a resolved skill. */
export function readSkillText(skill: SkillDefinition): string | null {
  try {
    return readFileSync(skill.path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Placeholders a skill may use to reference its own bundled files. Claude Code
 * substitutes `${CLAUDE_SKILL_DIR}` in skill markdown, and skills published for
 * that ecosystem rely on it, so an imported skill must keep working here. The
 * unprefixed alias is for skills authored against Modus directly.
 */
const SKILL_DIR_PLACEHOLDERS = ["${CLAUDE_SKILL_DIR}", "${SKILL_DIR}"];

/**
 * The activation payload for a skill, in the shape the Agent Skills ecosystem
 * uses (https://agentskills.io/specification).
 *
 * Two rules come from the spec and from how Claude Code implements it:
 *
 * - **Frontmatter is stripped.** The spec's progressive-disclosure model loads
 *   `name`/`description` at discovery time; they exist to help *select* a skill.
 *   Replaying them at activation is noise, and their "use when…" phrasing reads
 *   as a contradictory instruction to an agent already holding the skill.
 * - **The base path leads.** The spec tells skill authors to reference bundled
 *   files with paths "relative to the skill root" (`references/REFERENCE.md`),
 *   which is unresolvable unless the agent is told that root. Claude Code emits
 *   `Base Path: <dir>` ahead of the body; matching that wording verbatim means a
 *   skill written for either harness behaves identically in this one.
 */
export function buildSkillPayload(skill: SkillDefinition): string | null {
  const raw = readSkillText(skill);
  if (raw === null) return null;
  const { body } = parseSkillFrontmatter(raw);
  let text = body.trim();
  for (const placeholder of SKILL_DIR_PLACEHOLDERS) {
    text = text.split(placeholder).join(skill.dir);
  }
  return `Base Path: ${skill.dir}\n\n${text}`;
}

function listSkillNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// ── Installed skills ──

type SkillRoot = {
  dir: string;
  origin: SkillOrigin;
  pluginId?: string;
};

/** Search roots for installed skills, most specific first. */
function installedSkillRoots(cwd: string): SkillRoot[] {
  const roots: SkillRoot[] = [
    { dir: join(cwd, PROJECT_SKILLS_DIR), origin: "project" },
    { dir: homeSkillsDir(), origin: "user" },
  ];
  for (const plugin of listEnabledModusPlugins()) {
    roots.push({ dir: getPluginSkillsDir(plugin), origin: "plugin", pluginId: plugin.id });
  }
  return roots;
}

/**
 * Resolve an installed skill by name. Project beats user beats plugin —
 * the same most-specific-wins rule moves use.
 */
export function getInstalledSkill(name: string, cwd: string): SkillDefinition | null {
  for (const root of installedSkillRoots(cwd)) {
    const dir = join(root.dir, name);
    if (!existsSync(join(dir, SKILL_FILE))) continue;
    const skill = readSkillDir(dir, name, root.origin, { pluginId: root.pluginId });
    if (skill) return skill;
  }
  return null;
}

/**
 * Every installed skill visible from `cwd`, deduped by name with the winner
 * kept. Shadowed duplicates are reported once so a plugin quietly losing to a
 * project skill is visible in the backend log rather than silent.
 */
export function listInstalledSkills(cwd: string): SkillDefinition[] {
  const winners = new Map<string, SkillDefinition>();
  for (const root of installedSkillRoots(cwd)) {
    for (const name of listSkillNames(root.dir)) {
      const skill = readSkillDir(join(root.dir, name), name, root.origin, { pluginId: root.pluginId });
      if (!skill) continue;
      const existing = winners.get(name);
      if (existing) {
        console.warn(
          `[skills] "${name}" from ${describeSource(skill)} is shadowed by ${describeSource(existing)}`,
        );
        continue;
      }
      winners.set(name, skill);
    }
  }
  return Array.from(winners.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Human-readable provenance, for logs and disclosure surfaces. */
export function describeSource(skill: SkillDefinition): string {
  if (skill.origin === "plugin") return `plugin "${skill.pluginId}"`;
  if (skill.origin === "move") return `move "${skill.moveName}"`;
  return skill.origin;
}

// ── Move-bundled skills ──

/** Skills bundled inside a move directory. Reachable only while the move is attached. */
export function listMoveSkills(moveDir: string, moveName: string): SkillDefinition[] {
  const root = join(moveDir, MOVE_SKILLS_DIR);
  return listSkillNames(root)
    .map((name) => readSkillDir(join(root, name), name, "move", { moveName }))
    .filter((skill): skill is SkillDefinition => skill !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Skills a plugin ships, for the About/disclosure surface. */
export function listPluginSkills(plugin: ModusPlugin): SkillDefinition[] {
  const root = getPluginSkillsDir(plugin);
  return listSkillNames(root)
    .map((name) => readSkillDir(join(root, name), name, "plugin", { pluginId: plugin.id }))
    .filter((skill): skill is SkillDefinition => skill !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}
