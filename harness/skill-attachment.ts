/**
 * Skill attachment — which skills a session can actually see.
 *
 * Installing a skill does not make it available. A profile, move, or action
 * must attach it. Attachment is resolved once when a session starts and
 * amended when a move activates later, then held in memory keyed by an
 * unguessable scope key that appears in the session's MCP endpoint URL.
 *
 * Resolution precedence, first wins:
 *   1. directly attached names (profile / action `skills`)
 *   2. installed skills referenced by an active move's `skills`
 *   3. skills bundled inside an active move at `<move>/skills/`
 *
 * So a project skill always beats a move-bundled one of the same name, matching
 * the most-specific-wins rule used for installed skills and for moves.
 *
 * Names that resolve to nothing are reported, never fatal — shipped templates
 * carry `skills` entries that may not exist on a given machine, and an agent
 * session must not fail to start over a missing piece of reference text.
 *
 * Deliberately a leaf: imports `skills.ts` and nothing else, so attachment can
 * be tested without loading the move runner or the database.
 */

import { getInstalledSkill, listMoveSkills, type SkillDefinition } from "./skills";

/** A move contributing skills to a session. Callers pass resolved move locations
 *  so this module never needs the move runner. */
export type MoveSkillSource = {
  name: string;
  /** Absolute move directory — `<dir>/skills/` is scanned for bundled skills. */
  dir: string;
  /** Installed skill names referenced by the move's `move.json`. */
  skills?: string[];
};

export type SkillCollection = {
  skills: SkillDefinition[];
  /** Attached names that resolved to nothing, with who asked for them. */
  missing: { name: string; requestedBy: string }[];
};

/**
 * Resolve an attachment request into concrete skills.
 * Pure — no session state, no I/O beyond reading the skill files themselves.
 */
export function collectSkills(
  cwd: string,
  opts: { names?: string[]; moves?: MoveSkillSource[] } = {},
): SkillCollection {
  const skills = new Map<string, SkillDefinition>();
  const missing: SkillCollection["missing"] = [];

  const takeInstalled = (name: string, requestedBy: string) => {
    if (skills.has(name)) return;
    const skill = getInstalledSkill(name, cwd);
    if (skill) skills.set(name, skill);
    else missing.push({ name, requestedBy });
  };

  for (const name of opts.names ?? []) takeInstalled(name, "profile");
  for (const move of opts.moves ?? []) {
    for (const name of move.skills ?? []) takeInstalled(name, `move "${move.name}"`);
  }
  for (const move of opts.moves ?? []) {
    for (const bundled of listMoveSkills(move.dir, move.name)) {
      if (!skills.has(bundled.name)) skills.set(bundled.name, bundled);
    }
  }

  return {
    skills: Array.from(skills.values()).sort((a, b) => a.name.localeCompare(b.name)),
    missing,
  };
}

// ── Session scope registry ──

type SessionSkillScope = {
  sessionId: string;
  skills: Map<string, SkillDefinition>;
};

/** scopeKey → attached skills. In-memory only; a restart re-resolves at session start. */
const scopes = new Map<string, SessionSkillScope>();
/** sessionId → scopeKey, so a later move activation amends the existing scope. */
const scopeKeys = new Map<string, string>();

const SCOPE_PREFIX = "skl-";

function mintScopeKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return SCOPE_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function addToScope(key: string, sessionId: string, skills: SkillDefinition[]): void {
  const scope = scopes.get(key) ?? { sessionId, skills: new Map<string, SkillDefinition>() };
  for (const skill of skills) {
    if (!scope.skills.has(skill.name)) scope.skills.set(skill.name, skill);
  }
  scopes.set(key, scope);
}

/**
 * Create a scope before the session exists.
 *
 * The MCP server URL is baked into the provider's config at spawn, but the
 * real session ID only exists after the provider initializes — so the key is
 * minted first and bound to the session afterward, the same ordering the move
 * API tokens use. Returns null for an empty set, which leaves the caller on
 * the plain endpoint.
 */
export function createSkillScope(skills: SkillDefinition[]): string | null {
  if (skills.length === 0) return null;
  const key = mintScopeKey();
  addToScope(key, "", skills);
  return key;
}

/** Bind a pre-minted scope to its session once the provider has assigned an ID. */
export function bindSessionSkillScope(sessionId: string, key: string): void {
  const scope = scopes.get(key);
  if (!scope) return;
  scope.sessionId = sessionId;
  scopeKeys.set(sessionId, key);
}

/**
 * Attach skills to a live session, creating its scope on first call.
 *
 * Note the provider already holds the URL it was spawned with: a session that
 * started with no skills has the plain endpoint, so skills attached later are
 * recorded but unreachable by tool until the session restarts. The composer's
 * `/skill` path injects text directly and is unaffected.
 */
export function attachSessionSkills(sessionId: string, skills: SkillDefinition[]): string | null {
  const existingKey = scopeKeys.get(sessionId);
  if (skills.length === 0) return existingKey ?? null;

  const key = existingKey ?? mintScopeKey();
  addToScope(key, sessionId, skills);
  scopeKeys.set(sessionId, key);
  return key;
}

/** Skills attached to a scope key, or null when the key is unknown. */
export function getScopedSkills(key: string): SkillDefinition[] | null {
  const scope = scopes.get(key);
  if (!scope) return null;
  return Array.from(scope.skills.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getScopedSkill(key: string, name: string): SkillDefinition | null {
  return scopes.get(key)?.skills.get(name) ?? null;
}

export function getSessionScopeKey(sessionId: string): string | null {
  return scopeKeys.get(sessionId) ?? null;
}

export function getSessionSkills(sessionId: string): SkillDefinition[] {
  const key = scopeKeys.get(sessionId);
  return key ? (getScopedSkills(key) ?? []) : [];
}

export function isSkillScopeKey(value: string): boolean {
  return value.startsWith(SCOPE_PREFIX);
}

/** Drop a session's scope. Safe to call for sessions that never attached one. */
export function releaseSessionSkills(sessionId: string): void {
  const key = scopeKeys.get(sessionId);
  if (!key) return;
  scopeKeys.delete(sessionId);
  scopes.delete(key);
}
