/**
 * Hints Launcher widget — cross-project intent gate.
 *
 * Two passes, deliberately unequal. The **grounded pass** runs client-side with
 * no model in the path: a debounced unscoped FTS5 call over every project, so
 * matching sessions are on screen while the user is still typing. The **agent
 * pass** fires the built-in `hints` move in background mode, polls
 * /api/move-runs/:id, and merges typed recommendation cards above the grounded
 * list. The first pass is what makes the second one optional — a slow or failed
 * router degrades to a search box rather than to nothing.
 *
 * **The product is a new session.** A `kind: "new"` card names a project, a
 * folder and an agent, and carries an opening message. Picking one **stages**
 * it: switch project, create the session, seed the composer draft, navigate —
 * and stop, so the user edits and hits send. Past sessions are research behind
 * the proposal, not the destination; `kind: "session"` exists for work that is
 * genuinely mid-flight and is deliberately the minority case.
 *
 * Harness-level widget. Registered in `zones: dashboard | left-panel | right-panel`.
 *
 * Config:
 *   { "type": "hints-launcher", "routerProfile": "hints-router", "autoFire": false }
 *
 * autoFire: when true, debounced typing fires the agent pass too (not just the
 * grounded pass). When false (default), the user presses "route" or ⌘↵.
 *
 * routerProfile names the agent that answers. It rides on the move's `inputs`,
 * which `buildSpawnSessionOpts` reads ahead of `move.json`'s own `agentProfile`
 * — so the page picks the router's model without forking the built-in move.
 * Unset means inherit the user profile default.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { modus, API_BASE, getAuthToken } from "../modusClient";
import { queueComposerAttach, queueComposerDraft } from "../client-extensions";
import { useProfiles } from "../providers/ProfileContext";
import { useActiveSessionId, useSessionActions } from "../providers/SessionContext";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";
import { useWidgetUiState } from "./ui-state";
import { sessionDisplayText, timeAgo } from "../utils/format";
import { composeDraft, projectForCwd, projectLabel, rootFor } from "../launch-target";
import type { MoveListItem, SearchHit, UserProfile } from "../../../sdk/index";

// ── Types ──

type HintsLauncherConfig = WidgetBase & {
  type: "hints-launcher";
  /** When true, debounced typing auto-fires the agent pass. Default: false. */
  autoFire?: boolean;
  /** Debounce delay in ms for autoFire. Default: 500. */
  autoFireDelayMs?: number;
  /** How many grounded search results to show. Default: 8. */
  groundedLimit?: number;
  /**
   * Agent profile that answers the routing query. Unset inherits the user
   * profile default, which is usually a full coding agent — far more than a
   * gate needs, and the user is waiting on it.
   */
  routerProfile?: string;
};

type RecommendationKind = "new" | "session" | "move";

interface Recommendation {
  kind: RecommendationKind;
  target: string;
  label: string;
  reason: string;
  confidence?: number;
  /** Project id (user profile name). Completed server-side from `target`. */
  project?: string;
  /** Folder to open in. Completed server-side from `target`. */
  cwd?: string;
  /** Agent profile to open with. Mirrors `target` for `kind: "new"`. */
  profile?: string;
  /** Short opening message, staged unsent. */
  prompt?: string;
  /** Reference lines about recent material. */
  references?: string[];
}

interface HintsPayload {
  recommendations: Recommendation[];
  passthrough: boolean;
  note?: string;
}

type HintsState =
  | { phase: "idle" }
  | { phase: "running"; moveRunId: number; startedAt: number }
  | { phase: "done"; payload: HintsPayload; moveRunId: number }
  | { phase: "error"; error: string };

interface MoveRunRow {
  id: number;
  status: string;
  summary: string | null;
  error?: string | null;
  completed_at?: number | null;
  completedAt?: number | null;
}

/** A grounded hit plus the project it resolves to. */
type GroundedRow = SearchHit & { project: string | null; projectLabel: string };

/** Everything a launch needs. Assembled from a card or from a grounded row. */
type LaunchTarget = {
  sessionId?: string;
  project: string | null;
  cwd?: string;
  profile?: string;
  prompt: string;
  move?: MoveListItem;
};

const AGENT_TIMEOUT_MS = 90_000;

// ── Minimal fetch helper (the client has no generic GET for /api/move-runs/:id yet) ──

async function fetchMoveRun(id: number): Promise<MoveRunRow | null> {
  const token = getAuthToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/move-runs/${id}`, { headers });
  if (!res.ok) return null;
  return res.json();
}

// ── Project resolution ──
//
// A search hit carries a cwd but not a project. Resolving it client-side is
// what lets a grounded row be launched into the right project without waiting
// for the agent pass. The rules live in launch-target.ts, pure and pinned.

/** A grounded hit, resolved to the project that owns its folder. */
function resolveGrounded(hit: SearchHit, projects: UserProfile[]): GroundedRow {
  const project = projectForCwd(hit.cwd, projects);
  return { ...hit, project: project?.name ?? null, projectLabel: projectLabel(project) };
}

// ── Card renderers ──

function KindBadge({ kind }: { kind: RecommendationKind }) {
  const label = kind === "new" ? "new session" : kind === "session" ? "continue" : "move";
  return <span className={`hl-badge hl-badge--${kind}`}>{label}</span>;
}

const ACTION_LABEL: Record<RecommendationKind, string> = {
  new: "open as new session →",
  session: "continue session →",
  move: "stage move →",
};

function ConfidenceBar({ value }: { value?: number }) {
  if (value === undefined) return null;
  const pct = Math.round(value * 100);
  return (
    <span className="hl-confidence" title={`confidence ${pct}%`}>
      <span className="hl-confidence-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** project · profile · folder. Rendered as one dim mono line under the label. */
function TargetLine({ project, profile, cwd }: { project?: string | null; profile?: string; cwd?: string }) {
  const parts: string[] = [];
  if (project) parts.push(project);
  if (profile) parts.push(profile);
  if (!parts.length && !cwd) return null;
  return (
    <div className="hl-card-target">
      {parts.length > 0 && <span className="hl-card-where">{parts.join(" · ")}</span>}
      {cwd && <span className="hl-card-cwd" title={cwd}>{cwd}</span>}
    </div>
  );
}

// ── Widget ──

export default function HintsLauncherWidget({
  config,
  widgetId,
  onSelectSession,
  pageContext,
}: WidgetProps<HintsLauncherConfig>) {
  const { activeCwd, projectRoot, activeUserProfile, userProfiles, switchUserProfile } = useProfiles();
  const activeSessionId = useActiveSessionId();
  const { newSession, selectSession } = useSessionActions();
  const cwd = projectRoot ?? activeCwd;

  const [draft, setDraft] = useWidgetUiState<string>(
    { userProfile: activeUserProfile, cwd: activeCwd },
    widgetId,
    "draft",
    "",
  );
  const [profileHint, setProfileHint] = useState<string>("");
  const [state, setState] = useState<HintsState>({ phase: "idle" });
  const [grounded, setGrounded] = useState<GroundedRow[]>([]);
  const [groundedFor, setGroundedFor] = useState<string>("");
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  /** Per-card prompt edits, keyed by card index. Cleared when cards change. */
  const [promptEdits, setPromptEdits] = useState<Record<number, string>>({});
  const [cachedMoves, setCachedMoves] = useState<MoveListItem[]>([]);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const autoFire = !!config.autoFire;
  const autoFireDelayMs = config.autoFireDelayMs ?? 500;
  const groundedLimit = config.groundedLimit ?? 8;

  // Cache the moves list so we can translate "move" recommendations into
  // the MoveListItem shape that ChatInput expects on the `modus:attach-move` event.
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    modus.listMoves(cwd).then((items) => {
      if (!cancelled) setCachedMoves(items);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [cwd]);

  // ── Grounded pass: unscoped FTS5, no model, debounced while typing ──
  //
  // `userProfile` is deliberately omitted from the request so the search spans
  // every project. Where a session lives is the half the user cannot supply.

  useEffect(() => {
    const query = draft.trim();
    if (query.length < 3) {
      setGrounded([]);
      setGroundedFor("");
      return;
    }
    if (query === groundedFor) return;
    let cancelled = false;
    const t = setTimeout(() => {
      modus.searchSessions(query, { limit: groundedLimit })
        .then((hits) => {
          if (cancelled) return;
          setGrounded(hits.map((hit) => resolveGrounded(hit, userProfiles)));
          setGroundedFor(query);
        })
        .catch(() => { if (!cancelled) setGrounded([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [draft, groundedLimit, userProfiles, groundedFor]);

  // ── Agent pass ──

  const runHints = useCallback(async (text: string) => {
    if (!cwd) return;
    const query = text.trim();
    if (!query) return;
    setLaunchError(null);
    setState({ phase: "running", moveRunId: -1, startedAt: Date.now() });
    try {
      const result = await modus.activateProjectMove({
        moveName: "hints",
        inputs: {
          query,
          profileHint,
          // Read by buildSpawnSessionOpts ahead of move.json's agentProfile.
          ...(config.routerProfile ? { agentProfile: config.routerProfile } : {}),
        },
        cwd,
        userProfile: activeUserProfile ?? undefined,
        modeOverride: "background",
      });
      const runId = result.moveRunId;
      setState({ phase: "running", moveRunId: runId, startedAt: Date.now() });
    } catch (err) {
      setState({ phase: "error", error: String((err as Error).message ?? err) });
    }
  }, [cwd, profileHint, activeUserProfile, config.routerProfile]);

  // ── Poll for completion ──

  useEffect(() => {
    if (state.phase !== "running" || state.moveRunId < 0) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const row = await fetchMoveRun(state.moveRunId);
        if (cancelled) return;
        if (!row) {
          setTimeout(tick, 600);
          return;
        }
        if (row.status === "completed" && row.summary) {
          try {
            const payload = JSON.parse(row.summary) as HintsPayload;
            setState({ phase: "done", payload, moveRunId: row.id });
            setCursor(0);
            setExpanded(payload.recommendations.length > 0 ? 0 : null);
            setPromptEdits({});
            return;
          } catch {
            setState({ phase: "error", error: "hints returned invalid JSON" });
            return;
          }
        }
        if (row.status === "error") {
          setState({ phase: "error", error: row.error ?? "hints errored" });
          return;
        }
        // The agent now researches with ops before submitting, so the old 45s
        // ceiling cut off runs that were still working.
        if (Date.now() - state.startedAt > AGENT_TIMEOUT_MS) {
          setState({ phase: "error", error: "hints timed out — grounded results below are still good" });
          return;
        }
        setTimeout(tick, 600);
      } catch {
        setTimeout(tick, 1200);
      }
    };
    tick();
    return () => { cancelled = true; };
  }, [state]);

  // ── Auto-fire (debounced) ──

  useEffect(() => {
    if (!autoFire) return;
    if (!draft.trim()) return;
    if (state.phase === "running") return;
    const t = setTimeout(() => {
      runHints(draft);
    }, autoFireDelayMs);
    return () => clearTimeout(t);
  }, [draft, autoFire, autoFireDelayMs, runHints, state.phase]);

  // ── Launch: switch project, resume or create, stage the draft, navigate ──

  const launch = useCallback(async (target: LaunchTarget) => {
    setLaunchError(null);
    const project = target.project ?? activeUserProfile ?? null;
    try {
      let sid = target.sessionId;
      if (!sid) {
        sid = await modus.createEmptySession({
          ...(target.profile ? { profile: target.profile } : {}),
          ...(target.cwd ? { cwd: target.cwd } : {}),
          ...(project ? { userProfile: project } : {}),
        });
      }
      if (!sid) {
        setLaunchError("failed to create session");
        return;
      }

      // Stage before navigating. The target ChatInput has not mounted yet, so
      // both of these buffer until registerComposer(`composer:<sid>`) fires.
      if (target.move) {
        queueComposerAttach(`composer:${sid}`, target.move, { query: target.prompt });
      } else if (target.prompt.trim()) {
        queueComposerDraft(`composer:${sid}`, target.prompt);
      }

      // The project is stated, never inferred: a session created a moment ago
      // is not in the client's session index, so anything that derives the
      // project from it resolves to the project we are leaving.
      if (project !== activeUserProfile) switchUserProfile(project);
      await selectSession(sid);
      if (pageContext?.activateSession) pageContext.activateSession(sid, project);
      else onSelectSession(sid);

      setState({ phase: "idle" });
      setExpanded(null);
      setPromptEdits({});
      setDraft("");
    } catch (err) {
      setLaunchError(String((err as Error).message ?? err));
    }
  }, [activeUserProfile, switchUserProfile, selectSession, pageContext, onSelectSession, setDraft]);

  // ── Pick handlers ──

  const recommendations = state.phase === "done" ? state.payload.recommendations : [];

  const promptFor = useCallback((rec: Recommendation, index: number): string => {
    const edited = promptEdits[index];
    if (edited !== undefined) return edited;
    return composeDraft(rec.prompt ?? draft, rec.references);
  }, [promptEdits, draft]);

  const pickRecommendation = useCallback(async (rec: Recommendation, index: number) => {
    // Stated project wins; otherwise derive it from the folder the agent named,
    // and only then fall back to where the user is standing.
    const derived = rec.cwd ? projectForCwd(rec.cwd, userProfiles)?.name : undefined;
    const project: string | null = rec.project ?? derived ?? activeUserProfile;
    const projectProfile = userProfiles.find((p) => p.name === project) ?? null;
    const targetCwd = rec.cwd ?? rootFor(projectProfile, rec.cwd) ?? cwd;
    const prompt = promptFor(rec, index);

    if (rec.kind === "move") {
      const moveItem = cachedMoves.find((m) => m.name === rec.target);
      if (!moveItem) {
        setLaunchError(`move not found in this project: ${rec.target}`);
        return;
      }
      // A move stages on an existing session when there is one — attaching to a
      // fresh empty session would strand whatever the user was already doing.
      await launch({
        sessionId: activeSessionId ?? undefined,
        project: activeSessionId ? activeUserProfile ?? null : project,
        cwd: targetCwd,
        prompt,
        move: moveItem,
      });
      return;
    }

    await launch({
      sessionId: rec.kind === "session" ? rec.target : undefined,
      project,
      cwd: targetCwd,
      // For a new session the target IS the agent; `profile` is the same value
      // echoed back by onSubmit, so either carries it.
      profile: rec.kind === "new" ? (rec.profile ?? rec.target) : rec.profile,
      prompt,
    });
  }, [userProfiles, activeUserProfile, cwd, cachedMoves, activeSessionId, promptFor, launch]);

  const pickGrounded = useCallback(async (row: GroundedRow) => {
    await launch({
      sessionId: row.session_id,
      project: row.project,
      cwd: row.cwd ?? undefined,
      prompt: draft,
    });
  }, [draft, launch]);

  // ── Passthrough: send the draft as-is ──

  const sendAsTyped = useCallback(async () => {
    if (!cwd || !draft.trim()) return;
    try {
      let sid = activeSessionId;
      if (!sid) sid = await newSession();
      if (!sid) return;
      await modus.sendMessage(sid, { prompt: draft });
      onSelectSession(sid);
      setState({ phase: "idle" });
      setDraft("");
    } catch (err) {
      setLaunchError(String((err as Error).message ?? err));
    }
  }, [cwd, draft, activeSessionId, newSession, onSelectSession, setDraft]);

  // ── Keyboard nav ──

  const maxCursor = recommendations.length + grounded.length; // extra slot for "send as typed"

  const activateCursor = useCallback(() => {
    if (cursor < recommendations.length) {
      pickRecommendation(recommendations[cursor]!, cursor);
    } else if (cursor < maxCursor) {
      pickGrounded(grounded[cursor - recommendations.length]!);
    } else {
      sendAsTyped();
    }
  }, [cursor, recommendations, grounded, maxCursor, pickRecommendation, pickGrounded, sendAsTyped]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl + Enter → fire the agent pass
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runHints(draft);
      return;
    }
    if (maxCursor === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(maxCursor, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      activateCursor();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setState({ phase: "idle" });
      setExpanded(null);
    }
  }, [maxCursor, draft, runHints, activateCursor]);

  // ── UI ──

  const statusLine = useMemo(() => {
    if (launchError) return `error: ${launchError}`;
    if (state.phase === "running") return "routing…";
    if (state.phase === "error") return `error: ${state.error}`;
    if (state.phase === "done") {
      const n = state.payload.recommendations.length;
      if (n === 0) return state.payload.note ?? "nothing to propose — send as typed, or open one of the sessions below";
      return state.payload.note ?? `${n} proposal${n === 1 ? "" : "s"}`;
    }
    if (grounded.length > 0) return `${grounded.length} related session${grounded.length === 1 ? "" : "s"} found · ⌘↵ to propose a session`;
    return null;
  }, [state, grounded.length, launchError]);

  const statusPhase = launchError ? "error" : state.phase === "idle" ? "done" : state.phase;

  /**
   * "3 in Modus · 1 in LOPs" — which projects the draft already touches. This
   * is the folder half of the answer arriving with no model in the path, and
   * it is why the grounded pass renders even when the proposals are still
   * being written.
   */
  const groundedTally = useMemo(() => {
    if (grounded.length === 0) return null;
    const counts = new Map<string, number>();
    for (const row of grounded) counts.set(row.projectLabel, (counts.get(row.projectLabel) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([label, n]) => `${n} in ${label}`)
      .join(" · ");
  }, [grounded]);

  if (!cwd) {
    return <WidgetEmptyState>no project selected</WidgetEmptyState>;
  }

  return (
    <div className="hl-widget">
      <div className="hl-input-wrap">
        <textarea
          ref={inputRef}
          className="hl-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="what are you trying to do?"
          rows={3}
          spellCheck={false}
        />
        <div className="hl-input-actions">
          <input
            className="hl-profile-hint"
            value={profileHint}
            onChange={(e) => setProfileHint(e.target.value)}
            placeholder="profile hint (optional)"
            spellCheck={false}
          />
          <button
            type="button"
            className="hl-btn hl-btn--route"
            onClick={() => runHints(draft)}
            disabled={!draft.trim() || state.phase === "running"}
            title="⌘↵"
          >
            {state.phase === "running" ? "…" : "route"}
          </button>
        </div>
      </div>

      {statusLine && (
        <div className={`hl-status hl-status--${statusPhase}`}>{statusLine}</div>
      )}

      {recommendations.length > 0 && (
        <div className="hl-section">
          <div className="hl-section-head">proposed sessions</div>
          <div className="hl-cards">
            {recommendations.map((rec, i) => {
              const isOpen = expanded === i;
              return (
                <div
                  key={`${rec.kind}:${rec.target}:${i}`}
                  className={`hl-card hl-card--${rec.kind}${cursor === i ? " hl-card--active" : ""}`}
                >
                  <button
                    type="button"
                    className="hl-card-main"
                    onClick={() => { setCursor(i); setExpanded(isOpen ? null : i); }}
                  >
                    <div className="hl-card-head">
                      <KindBadge kind={rec.kind} />
                      <span className="hl-card-label">{rec.label}</span>
                      <ConfidenceBar value={rec.confidence} />
                    </div>
                    <div className="hl-card-reason">{rec.reason}</div>
                    <TargetLine
                      project={rec.project}
                      profile={rec.kind === "new" ? (rec.profile ?? rec.target) : rec.profile}
                      cwd={rec.cwd}
                    />
                  </button>

                  {/* grid-template-rows 0fr/1fr — the prompt never unmounts, so
                      an edit survives collapsing and reopening the card. */}
                  <div className={`hl-card-drawer${isOpen ? " hl-card-drawer--open" : ""}`}>
                    <div className="hl-card-drawer-inner">
                      <textarea
                        className="hl-prompt"
                        value={promptFor(rec, i)}
                        onChange={(e) => setPromptEdits((prev) => ({ ...prev, [i]: e.target.value }))}
                        rows={5}
                        spellCheck={false}
                        placeholder="starting prompt — edit before you open"
                      />
                      <div className="hl-card-actions">
                        <span className="hl-card-hint">staged, not sent</span>
                        <button
                          type="button"
                          className="hl-btn hl-btn--open"
                          onClick={() => pickRecommendation(rec, i)}
                        >
                          {ACTION_LABEL[rec.kind]}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {grounded.length > 0 && (
        <div className="hl-section hl-section--reference">
          <div className="hl-section-head">
            what this relates to
            {groundedTally && <span className="hl-section-tally">{groundedTally}</span>}
          </div>
          <div className="hl-cards">
            {grounded.map((row, i) => {
              const index = recommendations.length + i;
              return (
                <button
                  key={row.session_id}
                  type="button"
                  className={`hl-row${cursor === index ? " hl-row--active" : ""}`}
                  onClick={() => { setCursor(index); pickGrounded(row); }}
                >
                  <div className="hl-row-head">
                    <span className="hl-row-project">{row.projectLabel}</span>
                    <span className="hl-row-label">{sessionDisplayText(row)}</span>
                    <span className="hl-row-age">{timeAgo(row.last_message_at)}</span>
                  </div>
                  <div className="hl-row-snippet">{row.snippet}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {draft.trim() && (
        <button
          type="button"
          className={`hl-passthrough${cursor === maxCursor && maxCursor > 0 ? " hl-passthrough--active" : ""}`}
          onClick={sendAsTyped}
        >
          send as typed →
        </button>
      )}
    </div>
  );
}
