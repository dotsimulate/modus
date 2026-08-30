/**
 * Hints move (built-in) — new-session launcher brain.
 *
 * The product this serves: someone types a rough intent, and gets back a small
 * number of ready-to-open **new sessions** — a project, a folder, an agent, and
 * an opening message they can edit before sending. Past sessions are research
 * that informs those proposals, not the destination.
 *
 * ## Why this is a menu and not a form
 *
 * The first live run asked the model to emit `project`, `cwd`, `profile` and
 * `prompt` on every card, with the instruction "ALWAYS set project and cwd".
 * It returned a profile name, a reason, and none of the four — a card that
 * names an agent and cannot open anything. There is no enforcement to fall back
 * on either: `validateSchema` (move-runner.ts:1752) only checks top-level
 * `required` and shallow types, so it cannot reach inside `recommendations[]`,
 * and an `onSubmit` rejection marks the whole run `error`, which the widget
 * treats as terminal.
 *
 * So the shape changed instead of the wording. `gather()` publishes a catalog
 * of concrete (project, folder, agent) rows, each already openable, and the
 * model picks one `target` and writes the opening message. Everything
 * derivable is derived here — `resolveAgentTarget` maps a target back to its
 * project and root in `onSubmit`, so a card is complete even when the model
 * emits the minimum. Ask a model only for what cannot be looked up.
 *
 * The catalog carries descriptions **and** real usage counts from
 * `getProfileUsage`. Picking an agent from a list of names is a guess; picking
 * from names with descriptions and a usage history is a decision.
 *
 * `api.ops` widen the pre-fetch when it is not enough: `search` (cross-project
 * FTS5 with a recency window), `agents` (the full catalog, filterable), and
 * `read` (recent turns of a past session). Ops work in background mode because
 * activateMove appends the ops protocol before it branches on mode.
 *
 * onSubmit() normalizes and completes the payload, then serializes it into the
 * move run summary so the hints-launcher widget can poll /api/move-runs/:id.
 */

import type { MoveContext, MoveApiContext, MoveApiHandler, SubmitResult } from "../../move-types";
import { getProfileUsage, searchSessions, type ProfileUsageRow, type SearchHit } from "../../db";
import { listMoves } from "../../move-runner";
import { getAllProfiles, getAllUserProfiles } from "../../profiles";
import { buildProjectDescriptors, resolveSessionProject, type SessionProjectDescriptor } from "../../session-projects";

// ── Types ──

/** A concrete, already-openable destination: a project, a folder, an agent. */
interface AgentRow {
  /** Profile key as the recommendation's `target`. */
  target: string;
  /** Project id (user profile name). */
  project: string;
  projectName: string;
  /** Folder the session opens in — one of that project's configured roots. */
  cwd: string;
  description?: string;
  model?: string;
  /** Sessions started with this agent in this project inside the usage window. */
  sessions: number;
  lastUsedAt: number;
}

interface HintsRecommendation {
  /** "new" = open a new session (the default answer). */
  kind: "new" | "session" | "move";
  /** Agent profile key, session id, or move name depending on kind. */
  target: string;
  label: string;
  reason: string;
  confidence?: number;
  /** Project id. Derived from `target` when the model omits it. */
  project?: string;
  /** Folder. Derived from `target` when the model omits it. */
  cwd?: string;
  /** Agent profile to open with. Mirrors `target` for `kind: "new"`. */
  profile?: string;
  /** Opening message, staged into the composer unsent and editable. */
  prompt?: string;
  /** Reference lines about recent material. */
  references?: string[];
}

interface HintsPayload {
  recommendations: HintsRecommendation[];
  passthrough: boolean;
  note?: string;
}

// ── Scaffolding move taxonomy ──
//
// These are the built-in moves that CREATE new modus primitives. The gate
// should know about them so that when a user says "I want a new agent for X"
// or "build me a dashboard for Y", the right scaffolding move is surfaced.

const SCAFFOLDING_MOVE_HINTS: Record<string, string> = {
  "create-profile":  "User wants a new agent/persona — different behavior, tools, or system prompt.",
  "create-page":     "User wants a new custom dashboard/page with widgets, terminals, grid regions.",
  "create-move":     "User wants a new move — a reusable named invocation they can trigger later.",
  "create-action":   "User wants automation that fires on triggers (round end, cron, events).",
  "create-mission":  "User wants a multi-agent orchestrated workflow with named roles + handoffs.",
  "create-theme":    "User wants a new visual theme for the project.",
  "handoff":         "User wants to delegate the current thread to a different agent/profile.",
};

const DAY_MS = 86_400_000;
/** Usage window for the catalog. Long enough to rank, short enough to be current. */
const DEFAULT_USAGE_DAYS = 60;
/** Catalog rows in the prompt. The `agents` op serves the full list on demand. */
const CATALOG_LIMIT = 34;

// ── Shared helpers ──

function clampNum(val: unknown, def: number, max: number): number {
  const n = typeof val === "number" && Number.isFinite(val) ? val : def;
  return Math.min(Math.max(1, Math.floor(n)), max);
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function isoDay(ts: number): string {
  return new Date(ts).toISOString().split("T")[0]!;
}

function projectDescriptors(): SessionProjectDescriptor[] {
  try {
    return buildProjectDescriptors(getAllUserProfiles());
  } catch {
    return [];
  }
}

// ── The agent catalog ──

/**
 * Fold usage rows onto `${projectId}::${profileKey}`.
 *
 * Two thirds of the sessions table predates the `user_profile` column, so a row
 * with a null owner is attributed by path through the same resolver the rest of
 * the harness uses. Without that, the usage counts silently describe only
 * recent history and an older, heavily-used agent looks unused.
 */
function usageIndex(rows: ProfileUsageRow[], projects: SessionProjectDescriptor[]): Map<string, { sessions: number; lastUsedAt: number }> {
  const index = new Map<string, { sessions: number; lastUsedAt: number }>();
  for (const row of rows) {
    const projectId = row.userProfile
      ?? resolveSessionProject({ cwd: row.cwd }, projects).projectId;
    if (!projectId) continue;
    const key = `${projectId}::${row.profile}`;
    const prior = index.get(key);
    index.set(key, {
      sessions: (prior?.sessions ?? 0) + row.sessions,
      lastUsedAt: Math.max(prior?.lastUsedAt ?? 0, row.lastUsedAt),
    });
  }
  return index;
}

/**
 * Every openable (project, folder, agent) triple, ranked by real use.
 *
 * Profiles resolve per folder, so a project with several roots can expose
 * different agents in each; the first root that exposes a key owns the row, and
 * a duplicate key in a second root is skipped rather than listed twice.
 */
function buildAgentCatalog(usageDays = DEFAULT_USAGE_DAYS): AgentRow[] {
  const projects = projectDescriptors();
  let usage: Map<string, { sessions: number; lastUsedAt: number }>;
  try {
    usage = usageIndex(getProfileUsage({ sinceDays: usageDays, limit: 1000 }), projects);
  } catch {
    usage = new Map();
  }

  const rows: AgentRow[] = [];
  for (const project of projects) {
    const seen = new Set<string>();
    for (const root of project.roots) {
      let profiles: Record<string, { description?: string; model?: string }>;
      try {
        profiles = getAllProfiles(root) as Record<string, { description?: string; model?: string }>;
      } catch {
        continue;
      }
      for (const [key, profile] of Object.entries(profiles)) {
        if (seen.has(key)) continue;
        seen.add(key);
        const stat = usage.get(`${project.id}::${key}`);
        rows.push({
          target: key,
          project: project.id,
          projectName: project.name,
          cwd: root,
          description: profile.description,
          model: profile.model,
          sessions: stat?.sessions ?? 0,
          lastUsedAt: stat?.lastUsedAt ?? 0,
        });
      }
    }
  }

  return rows.sort((a, b) => b.sessions - a.sessions || b.lastUsedAt - a.lastUsedAt || a.target.localeCompare(b.target));
}

/**
 * Complete a recommendation from its target. This is what makes the model's
 * minimum output a working card: it emits an agent and a message, and the
 * project and folder come from the catalog rather than from the model's memory
 * of a path.
 */
function resolveAgentTarget(
  target: string,
  catalog: AgentRow[],
  preferredProject?: string,
): AgentRow | undefined {
  const matches = catalog.filter((row) => row.target === target);
  if (matches.length === 0) return undefined;
  if (preferredProject) {
    const preferred = matches.find((row) => row.project === preferredProject);
    if (preferred) return preferred;
  }
  return matches[0];
}

function renderCatalogRow(row: AgentRow, usageDays: number): string {
  const lines = [
    `- target=\`${row.target}\` project=\`${row.project}\` cwd=\`${row.cwd}\``,
  ];
  const stat = row.sessions > 0
    ? `${row.sessions} session${row.sessions === 1 ? "" : "s"} in the last ${usageDays}d, last ${isoDay(row.lastUsedAt)}`
    : "never used";
  lines.push(`    use: ${stat}${row.model ? ` · model ${row.model}` : ""}`);
  if (row.description) lines.push(`    is: ${oneLine(row.description, 190)}`);
  return lines.join("\n");
}

/** A hit carries a cwd but not a project; resolving it is what makes it citable. */
function renderHit(hit: SearchHit, projects: SessionProjectDescriptor[]): string {
  const match = resolveSessionProject({ cwd: hit.cwd }, projects);
  const lines = [
    `- id=\`${hit.session_id}\` project="${match.projectName ?? "(unconfigured)"}" agent=\`${hit.profile ?? "?"}\` date=${isoDay(hit.last_message_at)}`,
  ];
  const preview = oneLine(hit.preview ?? "", 100);
  const snippet = oneLine(hit.snippet ?? "", 150);
  if (preview) lines.push(`    was: ${preview}`);
  if (snippet && snippet !== preview) lines.push(`    match: ${snippet}`);
  return lines.join("\n");
}

/** Merge hit lists, keeping the first occurrence of each session. */
function dedupeHits(...lists: SearchHit[][]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const list of lists) {
    for (const hit of list) {
      if (seen.has(hit.session_id)) continue;
      seen.add(hit.session_id);
      out.push(hit);
    }
  }
  return out;
}

// ── gather() ──

export async function gather(ctx: MoveContext): Promise<string> {
  const query = String(ctx.inputs?.query ?? "").trim();
  const profileHint = String(ctx.inputs?.profileHint ?? "").trim();

  if (!query) {
    return "You received an empty routing query. Respond with modus_submit({ recommendations: [], passthrough: true, note: \"empty query\" }).";
  }

  const projects = projectDescriptors();
  const callerProject = resolveSessionProject(
    { user_profile: ctx.userProfile ?? null, cwd: ctx.cwd ?? null },
    projects,
  );

  // ── Recent activity (research, not destinations) ──
  //
  // Unscoped answers "which project does this belong to", which is the half the
  // user cannot supply. The caller-scoped pass guarantees the current project is
  // represented even when another outranks it lexically. Both best-effort — a
  // launcher must still answer when search is unavailable.
  let globalHits: SearchHit[] = [];
  let localHits: SearchHit[] = [];
  try {
    globalHits = searchSessions(query, 8);
  } catch { /* best effort */ }
  try {
    if (ctx.cwd) localHits = searchSessions(query, 5, { cwdPrefixes: [ctx.cwd] });
  } catch { /* best effort */ }
  const sessionHits = dedupeHits(localHits, globalHits).slice(0, 10);

  // ── The agent catalog, biased toward where the draft already lives ──
  const fullCatalog = buildAgentCatalog();
  const hitProjects = new Set(
    sessionHits
      .map((hit) => resolveSessionProject({ cwd: hit.cwd }, projects).projectId)
      .filter((id): id is string => !!id),
  );
  if (callerProject.projectId) hitProjects.add(callerProject.projectId);

  const relevant = fullCatalog.filter((row) => hitProjects.has(row.project));
  const rest = fullCatalog.filter((row) => !hitProjects.has(row.project));
  const catalog = [...relevant, ...rest].slice(0, CATALOG_LIMIT);
  const omitted = fullCatalog.length - catalog.length;

  // ── Moves ──
  let moves: ReturnType<typeof listMoves> = [];
  try {
    moves = listMoves(ctx.cwd);
  } catch { /* swallow */ }
  moves = moves.filter((m) => m.name !== "hints");

  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const scoreMove = (m: { name: string; label: string; description?: string | null; tags?: string[] | null }): number => {
    const hay = [m.name, m.label, m.description ?? "", ...(m.tags ?? [])].join(" ").toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (hay.includes(term)) score += 1;
      if (m.name.toLowerCase().includes(term)) score += 2;
      if ((m.tags ?? []).some((t) => t.toLowerCase() === term)) score += 3;
    }
    return score;
  };
  const rankedMoves = moves
    .map((m) => ({ m, score: scoreMove(m) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  const scaffoldingMoves = moves
    .filter((m) => m.name in SCAFFOLDING_MOVE_HINTS)
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── Build the prompt ──

  const lines: string[] = [
    "You are a launcher. Someone typed a rough intent and wants to be handed a place to start working.",
    "",
    "**Your default answer is a NEW session.** Return one to three ready-to-open proposals, each naming an agent from the catalog below and carrying a short opening message the user will edit and send.",
    "",
    `Draft (typed from ${ctx.cwd ?? "unknown"}, project "${callerProject.projectName ?? ctx.userProfile ?? "none"}"):`,
    "```",
    query,
    "```",
    profileHint ? `The user hinted at profile \`${profileHint}\`.` : "",
    "",
    "You are not restricted to the current project. Any row in the catalog is openable.",
    "",
    "## Agent catalog — pick `target` from here",
    "",
    "Each row is already a complete destination. You only need its `target`; the project and folder are attached to it automatically. Never write a folder path yourself.",
    "",
  ];

  if (catalog.length > 0) {
    for (const row of catalog) lines.push(renderCatalogRow(row, DEFAULT_USAGE_DAYS));
    if (omitted > 0) {
      lines.push("");
      lines.push(`(${omitted} more agents exist in other projects — call the \`agents\` op if none of the above fit.)`);
    }
  } else {
    lines.push("(no agent profiles are configured — return passthrough: true)");
  }
  lines.push("");

  lines.push("## Recent activity related to the draft");
  lines.push("");
  lines.push("This is **research**, not a list of destinations. Use it to work out which project the draft belongs to, what already happened, and what to put in `references`.");
  lines.push("");
  if (sessionHits.length > 0) {
    for (const hit of sessionHits) lines.push(renderHit(hit, projects));
  } else {
    lines.push("(nothing matched — widen with the `search` op before assuming this is new work)");
  }
  lines.push("");

  if (rankedMoves.length > 0) {
    lines.push("## Moves matching the draft");
    for (const { m } of rankedMoves) {
      lines.push(`- name=\`${m.name}\` label="${m.label}"`);
      if (m.description) lines.push(`    ${oneLine(m.description, 160)}`);
    }
    lines.push("");
  }

  if (scaffoldingMoves.length > 0) {
    lines.push("## Scaffolding moves (always candidates)");
    lines.push("Recommend one of these instead when the draft describes CREATING a new modus primitive.");
    for (const m of scaffoldingMoves) {
      const hint = SCAFFOLDING_MOVE_HINTS[m.name] ?? "";
      lines.push(`- name=\`${m.name}\`${hint ? ` — ${hint}` : ""}`);
    }
    lines.push("");
  }

  lines.push("## Your ops");
  lines.push("- `agents` — the full catalog, filterable by `project` or `query`, with a `sinceDays` usage window. Use it when nothing above fits.");
  lines.push("- `search` — cross-project FTS5. Pass `sinceDays` when the draft says \"recently\" / \"the other day\"; pass `project` to check somewhere the pre-fetch missed.");
  lines.push("- `read` — the last turns of a past session. Do this for the one or two sessions that would change your answer. A `reason` that names what actually happened is worth far more than one that paraphrases a snippet above.");
  lines.push("- Budget about 2-5 calls. The user is watching a spinner and the client already shows them the raw search results.");
  lines.push("");
  lines.push("## Rules");
  lines.push("- Prefer `kind: \"new\"`. That is the product: a folder, an agent, and a message ready to edit.");
  lines.push("- Only use `kind: \"session\"` when the work is literally mid-flight in that exact session — unfinished, and the draft is obviously the next thing to say in it. Continuing a finished conversation is worse than starting a clean one.");
  lines.push("- Use `kind: \"move\"` when the draft describes creating a new modus primitive.");
  lines.push("- If two proposals differ only cosmetically, return one. Two to three genuinely different options (a different project, or a different agent for the same work) beat four near-duplicates.");
  lines.push("- If nothing fits at all, return `{ recommendations: [], passthrough: true }`.");
  lines.push("- Confidence is 0-1, honestly calibrated — most answers belong between 0.4 and 0.7.");
  lines.push("");
  lines.push("## Writing `prompt` — this is the deliverable");
  lines.push("The client stages `prompt` into the composer UNSENT for the user to edit. It is the opening line of the conversation, written in their voice, first person.");
  lines.push("- One to three sentences. Restate the intent with the specifics you verified.");
  lines.push("- DO NOT write an execution plan, a task list, a spec, a design document, or acceptance criteria. The session you are opening does that work, with far more context than you have.");
  lines.push("- If the user's draft already says it well, reuse it almost verbatim rather than inventing prose.");
  lines.push("- `references` is where recent material goes: up to 4 lines, `<sessionId> · <YYYY-MM-DD> · <what happened, one clause>`. The client renders them as a fenced block below the prompt. Only cite sessions you actually looked at.");
  lines.push("");
  lines.push("## Output");
  lines.push(`Call modus_submit with token \`${ctx.token}\` and this shape:`);
  lines.push("```");
  lines.push("{");
  lines.push("  \"recommendations\": [");
  lines.push("    {");
  lines.push("      \"kind\": \"new\",");
  lines.push("      \"target\": \"<a target from the agent catalog>\",");
  lines.push("      \"label\": \"<short card title>\",");
  lines.push("      \"reason\": \"<one line: why here, why this agent>\",");
  lines.push("      \"prompt\": \"<the opening message, 1-3 sentences>\",");
  lines.push("      \"references\": [\"<sessionId> · <date> · <what happened>\"],");
  lines.push("      \"confidence\": 0.55");
  lines.push("    }");
  lines.push("  ],");
  lines.push("  \"passthrough\": false,");
  lines.push("  \"note\": \"<optional one-line summary>\"");
  lines.push("}");
  lines.push("```");
  lines.push("`project` and `cwd` are filled in for you from `target`. Research with the ops if you need to, then one submit call, then stop.");

  return lines.filter((l) => l !== undefined).join("\n");
}

// ── Handlers ──
//
// Unscoped by default: where the user is standing is not where the answer has
// to live. `project` narrows explicitly.

export const handlers: Record<string, MoveApiHandler> = {

  agents: async (_ctx: MoveApiContext, data: Record<string, unknown>) => {
    const usageDays = clampNum(data.sinceDays, DEFAULT_USAGE_DAYS, 730);
    let catalog = buildAgentCatalog(usageDays);
    if (catalog.length === 0) return { ok: true, message: "No agent profiles are configured in any project." };

    const projectFilter = typeof data.project === "string" ? data.project.trim() : "";
    if (projectFilter) {
      const before = catalog.length;
      catalog = catalog.filter((row) => row.project === projectFilter || row.projectName === projectFilter);
      if (catalog.length === 0) {
        const ids = [...new Set(buildAgentCatalog(usageDays).map((row) => row.project))];
        return { ok: false, error: `unknown project "${projectFilter}" (${before} rows exist). Valid ids: ${ids.join(", ")}` };
      }
    }

    const query = typeof data.query === "string" ? data.query.trim().toLowerCase() : "";
    if (query) {
      const terms = query.split(/\s+/).filter(Boolean);
      catalog = catalog.filter((row) => {
        const hay = `${row.target} ${row.projectName} ${row.description ?? ""}`.toLowerCase();
        return terms.some((term) => hay.includes(term));
      });
      if (catalog.length === 0) return { ok: true, message: `No agents matched "${query}". Call agents with no query to see them all.` };
    }

    const limit = clampNum(data.limit, 40, 200);
    const shown = catalog.slice(0, limit);
    const lines = [
      `${shown.length} agent${shown.length === 1 ? "" : "s"}${catalog.length > shown.length ? ` of ${catalog.length}` : ""}, ranked by use over the last ${usageDays} days:`,
      "",
    ];
    for (const row of shown) lines.push(renderCatalogRow(row, usageDays));
    return { ok: true, message: lines.join("\n") };
  },

  search: async (_ctx: MoveApiContext, data: Record<string, unknown>) => {
    const query = typeof data.query === "string" ? data.query.trim() : "";
    if (!query) return { ok: false, error: "query is required" };

    const limit = clampNum(data.limit, 10, 30);
    const projects = projectDescriptors();

    const projectId = typeof data.project === "string" ? data.project.trim() : "";
    let cwdPrefixes: string[] | undefined;
    if (projectId) {
      const descriptor = projects.find((p) => p.id === projectId || p.name === projectId);
      if (!descriptor) {
        return { ok: false, error: `unknown project "${projectId}" — call the agents op for valid ids` };
      }
      cwdPrefixes = descriptor.roots.length ? descriptor.roots : undefined;
    }

    const profile = typeof data.profile === "string" && data.profile.trim() ? data.profile.trim() : undefined;
    const role = data.role === "user" || data.role === "assistant" ? data.role : undefined;
    const sinceDays = typeof data.sinceDays === "number" && data.sinceDays > 0 ? data.sinceDays : undefined;

    const scope = {
      ...(cwdPrefixes ? { cwdPrefixes } : {}),
      ...(profile ? { agentProfiles: [profile] } : {}),
      ...(role ? { role } : {}),
    };

    // Over-fetch when a recency window will post-filter, so the window does not
    // silently shrink the result set below the requested limit.
    const fetchLimit = sinceDays ? Math.min(limit * 4, 60) : limit;
    let hits: SearchHit[];
    try {
      hits = searchSessions(query, fetchLimit, Object.keys(scope).length ? scope : undefined);
    } catch (err) {
      return { ok: false, error: `search failed: ${err}` };
    }

    if (sinceDays !== undefined) {
      const cutoff = Date.now() - sinceDays * DAY_MS;
      hits = hits.filter((h) => h.last_message_at >= cutoff);
    }
    hits = hits.slice(0, limit);

    if (hits.length === 0) {
      const window = sinceDays ? ` within ${sinceDays} day(s)` : "";
      return { ok: true, message: `No sessions found for "${query}"${window}.` };
    }

    const lines = [`Found ${hits.length} session${hits.length > 1 ? "s" : ""} for "${query}":`, ""];
    for (const hit of hits) lines.push(renderHit(hit, projects));
    return { ok: true, message: lines.join("\n") };
  },

  read: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
    if (!sessionId) return { ok: false, error: "sessionId is required" };

    const limit = clampNum(data.limit, 6, 20);
    const maxLength = clampNum(data.maxLength, 700, 3000);

    const session = ctx.db.getSession(sessionId);
    if (!session) return { ok: false, error: `session not found: ${sessionId}` };

    let turns;
    try {
      turns = ctx.db.getSessionMessages(sessionId);
    } catch (err) {
      return { ok: false, error: `read failed: ${err}` };
    }
    if (!turns.length) return { ok: true, message: `Session ${sessionId} has no readable turns.` };

    // The last turns are what a routing decision needs: "what was this last
    // about" beats "how did it open".
    const recent = turns.slice(-limit);
    const match = resolveSessionProject(session, projectDescriptors());

    const header = `Session \`${sessionId}\` — project "${match.projectName ?? "(unconfigured)"}", cwd \`${session.cwd ?? "?"}\`, agent \`${session.profile ?? "?"}\`, last active ${isoDay(session.lastMessageAt)}. Showing the last ${recent.length} of ${turns.length} turns.`;

    const body = recent.map((t) => {
      const role = t.role === "user" ? "USER" : "ASSISTANT";
      const tools = t.toolCalls?.length ? ` [${t.toolCalls.length} tool calls]` : "";
      const text = t.text.trim();
      const clipped = text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
      return `[${role}]${tools}\n${clipped}`;
    });

    return { ok: true, message: [header, "", ...body].join("\n\n") };
  },
};

// ── onSubmit() ──

export async function onSubmit(
  _ctx: MoveContext,
  data: Record<string, unknown>,
  _inputs: Record<string, unknown>,
): Promise<SubmitResult> {
  const recs = Array.isArray(data.recommendations) ? data.recommendations : [];
  const passthrough = data.passthrough === true;
  const note = typeof data.note === "string" ? data.note : undefined;

  const optionalString = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  };

  // Built once — a catalog scan per card would re-read every project's profile
  // directory for each recommendation.
  let catalog: AgentRow[] = [];
  try {
    catalog = buildAgentCatalog();
  } catch { /* completion degrades to whatever the model supplied */ }

  const clean: HintsRecommendation[] = [];
  for (const raw of recs) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;

    // "profile" was the pre-catalog name for the same thing. Normalize rather
    // than reject: the word appears in older prompts and in model priors, and
    // dropping the card would lose the only useful answer in the payload.
    const rawKind = r.kind === "profile" ? "new" : r.kind;
    if (rawKind !== "new" && rawKind !== "session" && rawKind !== "move") continue;
    const kind = rawKind;

    const target = optionalString(r.target);
    const label = optionalString(r.label);
    if (!target || !label) continue;
    if (typeof r.reason !== "string") continue;

    const confidence = typeof r.confidence === "number"
      ? Math.min(1, Math.max(0, r.confidence))
      : undefined;
    const references = Array.isArray(r.references)
      ? r.references
        .map((line) => (typeof line === "string" ? oneLine(line, 200) : ""))
        .filter(Boolean)
        .slice(0, 4)
      : undefined;

    let project = optionalString(r.project);
    let cwd = optionalString(r.cwd);
    let profile = optionalString(r.profile);

    // Completion. A "new" card is only useful if it names a folder and an
    // agent, and both are derivable from the catalog — so derive them rather
    // than depending on the model to have repeated them.
    if (kind === "new") {
      profile = profile ?? target;
      const row = resolveAgentTarget(target, catalog, project);
      if (row) {
        project = project ?? row.project;
        cwd = cwd ?? row.cwd;
      }
    }

    clean.push({
      kind,
      target,
      label,
      reason: r.reason.trim(),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(project ? { project } : {}),
      ...(cwd ? { cwd } : {}),
      ...(profile ? { profile } : {}),
      ...(optionalString(r.prompt) ? { prompt: optionalString(r.prompt)! } : {}),
      ...(references && references.length ? { references } : {}),
    });
  }

  if (clean.length === 0 && !passthrough) {
    return {
      error: "no valid recommendations and passthrough=false — return at least one recommendation or set passthrough: true",
    };
  }

  const payload: HintsPayload = {
    recommendations: clean,
    passthrough: clean.length === 0 || passthrough,
    ...(note ? { note } : {}),
  };

  // The move runner stores `message` as summary on the move_runs row.
  // Widget polls /api/move-runs/:id and parses summary as JSON.
  return { message: JSON.stringify(payload) };
}
