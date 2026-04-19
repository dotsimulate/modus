/**
 * Hints move (built-in) — intent gate / launcher brain.
 *
 * gather() pre-fetches ranked candidate sessions (via scoped FTS5 search),
 * the project's moves manifest, and a curated taxonomy of built-in scaffolding
 * moves. Returns a compact prompt that asks the agent to produce a typed
 * recommendations array via modus_submit.
 *
 * onSubmit() validates the shape and serializes the payload into the move run
 * summary field so the hints-launcher widget can poll /api/move-runs/:id and
 * render cards.
 *
 * Philosophy: routing is cheap + grounded. The agent doesn't freeform — it
 * ranks the pre-fetched candidates and returns a tight JSON array. Runs on
 * OpenRouter via the `hints` profile (gpt-4o-mini by default). No tools
 * beyond modus_submit.
 */

import type { MoveContext, SubmitResult } from "../../move-types";
import { searchSessions } from "../../db";
import { listMoves } from "../../move-runner";
import { getAllProfiles } from "../../profiles";

// ── Types ──

interface HintsRecommendation {
  kind: "session" | "move" | "profile";
  /** Session id, move name, or profile name depending on kind. */
  target: string;
  /** Short human-readable label for the card header. */
  label: string;
  /** One-line reason explaining why this matched. */
  reason: string;
  /** 0-1 confidence. Higher = more certain. */
  confidence?: number;
}

interface HintsPayload {
  recommendations: HintsRecommendation[];
  /** True if no recommendation is strong enough — client should just send as typed. */
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

// ── gather() ──

export async function gather(ctx: MoveContext): Promise<string> {
  const query = String(ctx.inputs?.query ?? "").trim();
  const profileHint = String(ctx.inputs?.profileHint ?? "").trim();

  if (!query) {
    return "You received an empty routing query. Respond with modus_submit({ recommendations: [], passthrough: true, note: \"empty query\" }).";
  }

  // ── Candidate sessions (FTS5, scoped to cwd + user profile) ──
  const sessionScope = {
    ...(ctx.cwd ? { cwdPrefixes: [ctx.cwd] } : {}),
    ...(ctx.userProfile ? { userProfileName: ctx.userProfile } : {}),
  };
  let sessionHits: ReturnType<typeof searchSessions> = [];
  try {
    sessionHits = searchSessions(query, 8, Object.keys(sessionScope).length ? sessionScope : undefined);
  } catch {
    // swallow — search is best-effort
  }

  // ── Candidate moves (name/label/description/tag match) ──
  let moves: ReturnType<typeof listMoves> = [];
  try {
    moves = listMoves(ctx.cwd);
  } catch {
    // swallow
  }

  // Strip the hints move itself from the candidate list — it would be silly
  // to recommend running hints as a hint.
  moves = moves.filter((m) => m.name !== "hints");

  const lower = query.toLowerCase();
  const queryTerms = lower.split(/\s+/).filter((t) => t.length > 2);

  const scoreMove = (m: { name: string; label: string; description?: string | null; tags?: string[] | null }): number => {
    const hay = [m.name, m.label, m.description ?? "", ...(m.tags ?? [])].join(" ").toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (hay.includes(term)) score += 1;
      if (m.name.toLowerCase().includes(term)) score += 2;
      if (m.label.toLowerCase().includes(term)) score += 1;
      if ((m.tags ?? []).some((t) => t.toLowerCase() === term)) score += 3;
    }
    return score;
  };

  const rankedMoves = moves
    .map((m) => ({ m, score: scoreMove(m) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  // Always surface available scaffolding moves (create-*, handoff) even when
  // they don't score — the model needs to know they exist to recommend them
  // for intent like "I want a new agent" that has no lexical overlap.
  const scaffoldingMoves = moves
    .filter((m) => m.name in SCAFFOLDING_MOVE_HINTS)
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── Candidate profiles ──
  let profiles: Array<{ name: string; description?: string; model?: string }> = [];
  try {
    const map = getAllProfiles(ctx.cwd);
    profiles = Object.entries(map).map(([name, p]) => ({
      name,
      description: (p as any).description,
      model: (p as any).model,
    }));
    // Hide the hints profile itself.
    profiles = profiles.filter((p) => p.name !== "hints");
  } catch {
    // swallow
  }

  // ── Build the prompt ──

  const lines: string[] = [
    "You are an intent-routing gate. The user is starting a new interaction. Look at their draft and recommend whether to:",
    "  - continue an existing conversation (kind: \"session\"),",
    "  - run a move — including scaffolding moves that create new primitives (kind: \"move\"), or",
    "  - start a new session with a specific agent profile (kind: \"profile\").",
    "",
    `User draft (cwd: ${ctx.cwd ?? "unknown"}, user: ${ctx.userProfile ?? "none"}):`,
    "```",
    query,
    "```",
    profileHint ? `User hinted profile: \`${profileHint}\`` : "",
    "",
    "## Pre-fetched candidates",
    "",
  ];

  if (sessionHits.length > 0) {
    lines.push("### Matching past sessions (FTS5, scoped)");
    for (const hit of sessionHits) {
      const date = new Date(hit.last_message_at).toISOString().split("T")[0];
      const preview = (hit.preview ?? "").slice(0, 120).replace(/\s+/g, " ").trim();
      const snippet = (hit.snippet ?? "").slice(0, 160).replace(/\s+/g, " ").trim();
      lines.push(`- id=\`${hit.session_id}\` profile=\`${hit.profile ?? "?"}\` date=${date}`);
      if (preview) lines.push(`    preview: ${preview}`);
      if (snippet) lines.push(`    match: ${snippet}`);
    }
    lines.push("");
  } else {
    lines.push("### Matching past sessions");
    lines.push("(none found)");
    lines.push("");
  }

  if (rankedMoves.length > 0) {
    lines.push("### Moves matching the draft lexically");
    for (const { m } of rankedMoves) {
      const tags = (m.tags ?? []).join(",");
      lines.push(`- name=\`${m.name}\` label="${m.label}" tags=[${tags}]`);
      if (m.description) lines.push(`    ${m.description.slice(0, 200)}`);
    }
    lines.push("");
  } else {
    lines.push("### Moves matching the draft lexically");
    lines.push("(none scored)");
    lines.push("");
  }

  // Always surface scaffolding moves — they rarely share vocabulary with
  // intent phrased in plain English ("make a new agent" → `create-profile`).
  if (scaffoldingMoves.length > 0) {
    lines.push("### Scaffolding moves (always candidates)");
    lines.push("Recommend these when the draft describes CREATING a new modus primitive.");
    for (const m of scaffoldingMoves) {
      const hint = SCAFFOLDING_MOVE_HINTS[m.name] ?? "";
      lines.push(`- name=\`${m.name}\` label="${m.label}"`);
      if (hint) lines.push(`    when: ${hint}`);
    }
    lines.push("");
  }

  if (profiles.length > 0) {
    lines.push("### Available agent profiles");
    for (const p of profiles.slice(0, 20)) {
      const desc = p.description ? ` — ${p.description.slice(0, 80)}` : "";
      lines.push(`- \`${p.name}\` (${p.model ?? "?"})${desc}`);
    }
    lines.push("");
  }

  lines.push("## Rules");
  lines.push("- Return 0-4 recommendations, ordered strongest first.");
  lines.push("- If nothing scores confidently (< 0.4), return `{ recommendations: [], passthrough: true }` — the client will just send the draft as-is.");
  lines.push("- Prefer existing sessions when the draft clearly continues one (user says \"the thing we discussed\", references prior work, or FTS5 matches are strong).");
  lines.push("- Prefer a scaffolding move (create-profile / create-page / create-move / create-action / create-mission / create-theme / handoff) when the draft describes making a NEW modus primitive.");
  lines.push("- Prefer a regular move when the draft matches a move's intent cleanly (e.g. \"research sessions about X\", \"hand this off to the architect\").");
  lines.push("- Prefer a profile when the draft is a fresh task that benefits from a non-default specialist.");
  lines.push("- `target` is the session id for session kind, the move name for move kind, or the profile name for profile kind.");
  lines.push("- Confidence is 0-1, calibrated honestly — most answers should be 0.4-0.7, not 0.95.");
  lines.push("");
  lines.push("## Output");
  lines.push(`Call modus_submit with token \`${ctx.token}\` and this exact shape:`);
  lines.push("```");
  lines.push("{");
  lines.push("  \"recommendations\": [");
  lines.push("    { \"kind\": \"session\"|\"move\"|\"profile\", \"target\": \"...\", \"label\": \"...\", \"reason\": \"...\", \"confidence\": 0.0-1.0 }");
  lines.push("  ],");
  lines.push("  \"passthrough\": boolean,");
  lines.push("  \"note\": \"optional short summary\"");
  lines.push("}");
  lines.push("```");
  lines.push("No other output. One submit call, then stop.");

  return lines.filter((l) => l !== undefined).join("\n");
}

// ── onSubmit() ──

export async function onSubmit(
  _ctx: MoveContext,
  data: Record<string, unknown>,
  _inputs: Record<string, unknown>,
): Promise<SubmitResult> {
  const recs = Array.isArray(data.recommendations) ? data.recommendations : [];
  const passthrough = data.passthrough === true;
  const note = typeof data.note === "string" ? data.note : undefined;

  // Validate each recommendation — tolerate unknowns but strip bad ones
  const clean: HintsRecommendation[] = [];
  for (const raw of recs) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const kind = r.kind;
    const target = r.target;
    const label = r.label;
    const reason = r.reason;
    if (kind !== "session" && kind !== "move" && kind !== "profile") continue;
    if (typeof target !== "string" || !target.trim()) continue;
    if (typeof label !== "string" || !label.trim()) continue;
    if (typeof reason !== "string") continue;
    const confidence = typeof r.confidence === "number"
      ? Math.min(1, Math.max(0, r.confidence))
      : undefined;
    clean.push({
      kind,
      target: target.trim(),
      label: label.trim(),
      reason: reason.trim(),
      ...(confidence !== undefined ? { confidence } : {}),
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
