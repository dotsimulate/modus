/**
 * Hints Launcher widget — intent-routing gate as a panel widget.
 *
 * Takes a draft intent, fires the built-in `hints` move in background mode,
 * polls /api/move-runs/:id for the completed payload, and renders
 * recommendation cards (session / move / profile) with keyboard nav.
 *
 * Harness-level widget. Registered in `zones: dashboard | left-panel | right-panel`.
 *
 * Integrates with the moves widget by dispatching the same `modus:attach-move`
 * event when the user picks a move recommendation AND a session is active.
 * Without a session, it creates one and either activates the move or sends
 * the draft directly.
 *
 * Config:
 *   { "type": "hints-launcher", "autoFire": false }
 *
 * autoFire: when true, debounced typing fires the gate automatically (400ms).
 * When false (default), the user must press the "hint" button or ⌘↵.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { modus, API_BASE, getAuthToken } from "../modusClient";
import { queueComposerAttach } from "../client-extensions";
import { useProfiles } from "../providers/ProfileContext";
import { useActiveSessionId, useSessionActions } from "../providers/SessionContext";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";
import { useWidgetUiState } from "./ui-state";
import type { MoveListItem } from "../../../sdk/index";

// ── Types ──

type HintsLauncherConfig = WidgetBase & {
  type: "hints-launcher";
  /** When true, debounced typing auto-fires the hints gate. Default: false. */
  autoFire?: boolean;
  /** Debounce delay in ms for autoFire. Default: 500. */
  autoFireDelayMs?: number;
};

type RecommendationKind = "session" | "move" | "profile";

interface Recommendation {
  kind: RecommendationKind;
  target: string;
  label: string;
  reason: string;
  confidence?: number;
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

// ── Minimal fetch helper (the client has no generic GET for /api/move-runs/:id yet) ──

async function fetchMoveRun(id: number): Promise<MoveRunRow | null> {
  const token = getAuthToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/move-runs/${id}`, { headers });
  if (!res.ok) return null;
  return res.json();
}

// ── Card renderer ──

function KindBadge({ kind }: { kind: RecommendationKind }) {
  const label = kind === "session" ? "continue" : kind === "move" ? "move" : "profile";
  return <span className={`hl-badge hl-badge--${kind}`}>{label}</span>;
}

function ConfidenceBar({ value }: { value?: number }) {
  if (value === undefined) return null;
  const pct = Math.round(value * 100);
  return (
    <span className="hl-confidence" title={`confidence ${pct}%`}>
      <span className="hl-confidence-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

function RecommendationCard({
  rec,
  active,
  onPick,
}: {
  rec: Recommendation;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className={`hl-card hl-card--${rec.kind}${active ? " hl-card--active" : ""}`}
      onClick={onPick}
    >
      <div className="hl-card-head">
        <KindBadge kind={rec.kind} />
        <span className="hl-card-label">{rec.label}</span>
        <ConfidenceBar value={rec.confidence} />
      </div>
      <div className="hl-card-reason">{rec.reason}</div>
      <div className="hl-card-target">{rec.target}</div>
    </button>
  );
}

// ── Widget ──

export default function HintsLauncherWidget({
  config,
  widgetId,
  onSelectSession,
}: WidgetProps<HintsLauncherConfig>) {
  const { activeCwd, projectRoot, activeUserProfile } = useProfiles();
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
  const [cursor, setCursor] = useState(0);
  const [cachedMoves, setCachedMoves] = useState<MoveListItem[]>([]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const autoFire = !!config.autoFire;
  const autoFireDelayMs = config.autoFireDelayMs ?? 500;

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

  // ── Fire the gate ──

  const runHints = useCallback(async (text: string) => {
    if (!cwd) return;
    const query = text.trim();
    if (!query) return;
    setState({ phase: "running", moveRunId: -1, startedAt: Date.now() });
    try {
      const result = await modus.activateProjectMove({
        moveName: "hints",
        inputs: { query, profileHint },
        cwd,
        userProfile: activeUserProfile ?? undefined,
        modeOverride: "background",
      });
      const runId = result.moveRunId;
      setState({ phase: "running", moveRunId: runId, startedAt: Date.now() });
    } catch (err) {
      setState({ phase: "error", error: String((err as Error).message ?? err) });
    }
  }, [cwd, profileHint, activeUserProfile]);

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
        // Timeout after 45s
        if (Date.now() - state.startedAt > 45_000) {
          setState({ phase: "error", error: "hints timed out" });
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

  // ── Pick handler ──

  const pickRecommendation = useCallback(async (rec: Recommendation) => {
    if (!cwd) return;

    if (rec.kind === "session") {
      // Navigate to existing session. Optionally pre-fill the input with our draft
      // so the user can hit send to continue.
      try {
        await selectSession(rec.target);
        onSelectSession(rec.target);
        // reset widget state
        setState({ phase: "idle" });
        setDraft("");
      } catch (err) {
        setState({ phase: "error", error: String(err) });
      }
      return;
    }

    if (rec.kind === "move") {
      const moveItem = cachedMoves.find((m) => m.name === rec.target);
      if (!moveItem) {
        setState({ phase: "error", error: `move not found: ${rec.target}` });
        return;
      }
      // Unified path: stage the move on the composer (chip above textarea) and
      // let the user hit send. If no session exists, create an empty one first —
      // queueComposerAttach buffers until the new ChatInput mounts, so there's
      // no race between session creation and event delivery.
      try {
        let sid = activeSessionId;
        if (!sid) {
          sid = await newSession();
          if (!sid) {
            setState({ phase: "error", error: "failed to create session" });
            return;
          }
          onSelectSession(sid);
        }
        queueComposerAttach(`composer:${sid}`, moveItem, { query: draft });
        setState({ phase: "idle" });
        setDraft("");
      } catch (err) {
        setState({ phase: "error", error: String((err as Error).message ?? err) });
      }
      return;
    }

    if (rec.kind === "profile") {
      try {
        const sid = await modus.createEmptySession({
          profile: rec.target,
          cwd,
          userProfile: activeUserProfile ?? undefined,
        });
        if (draft.trim()) {
          await modus.sendMessage(sid, { prompt: draft });
        }
        await selectSession(sid);
        onSelectSession(sid);
        setState({ phase: "idle" });
        setDraft("");
      } catch (err) {
        setState({ phase: "error", error: String((err as Error).message ?? err) });
      }
    }
  }, [cwd, cachedMoves, draft, activeSessionId, activeUserProfile, newSession, selectSession, onSelectSession, setDraft]);

  // ── Passthrough: send the draft as-is ──

  const sendAsTyped = useCallback(async () => {
    if (!cwd || !draft.trim()) return;
    try {
      let sid = activeSessionId;
      if (!sid) {
        sid = await newSession();
      }
      if (!sid) return;
      await modus.sendMessage(sid, { prompt: draft });
      onSelectSession(sid);
      setState({ phase: "idle" });
      setDraft("");
    } catch (err) {
      setState({ phase: "error", error: String((err as Error).message ?? err) });
    }
  }, [cwd, draft, activeSessionId, newSession, onSelectSession, setDraft]);

  // ── Keyboard nav ──

  const recommendations = state.phase === "done" ? state.payload.recommendations : [];
  const maxCursor = recommendations.length; // extra slot for "send as typed"

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl + Enter → fire hints
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runHints(draft);
      return;
    }
    if (state.phase !== "done" || recommendations.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(maxCursor, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (cursor < recommendations.length) {
        pickRecommendation(recommendations[cursor]);
      } else {
        sendAsTyped();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setState({ phase: "idle" });
    }
  }, [state.phase, recommendations, cursor, maxCursor, draft, runHints, pickRecommendation, sendAsTyped]);

  // ── UI ──

  const emptyCwd = !cwd;
  const statusLine = useMemo(() => {
    if (state.phase === "idle") return null;
    if (state.phase === "running") return "thinking…";
    if (state.phase === "error") return `error: ${state.error}`;
    if (state.phase === "done") {
      const n = state.payload.recommendations.length;
      if (n === 0) return state.payload.note ?? "no strong match — send as typed";
      return state.payload.note ?? `${n} hint${n === 1 ? "" : "s"}`;
    }
    return null;
  }, [state]);

  if (emptyCwd) {
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
          placeholder="what do you want to do?"
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
            {state.phase === "running" ? "…" : "hint"}
          </button>
        </div>
      </div>

      {statusLine && (
        <div className={`hl-status hl-status--${state.phase}`}>{statusLine}</div>
      )}

      {state.phase === "done" && state.payload.recommendations.length > 0 && (
        <div className="hl-cards">
          {state.payload.recommendations.map((rec, i) => (
            <RecommendationCard
              key={`${rec.kind}:${rec.target}:${i}`}
              rec={rec}
              active={cursor === i}
              onPick={() => pickRecommendation(rec)}
            />
          ))}
        </div>
      )}

      {(state.phase === "done" || state.phase === "error") && draft.trim() && (
        <button
          type="button"
          className={`hl-passthrough${cursor === recommendations.length ? " hl-passthrough--active" : ""}`}
          onClick={sendAsTyped}
        >
          send as typed →
        </button>
      )}
    </div>
  );
}
