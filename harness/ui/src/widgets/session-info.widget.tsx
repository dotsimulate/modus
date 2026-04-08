/**
 * Session Info widget — metadata for the active chat session.
 *
 * Config example (in user profile dashboard.widgets or LeftPanel widgets prop):
 *   { "id": "session-info-left", "type": "session-info" }
 */

import { useState, useEffect } from "react";
import { useSession } from "../providers/SessionContext";
import { useProfiles } from "../providers/ProfileContext";
import { fmtCost, fmtNum } from "../utils/format";
import type { WidgetDef } from "./types";
import { WidgetEmptyState } from "./widget-components";

// ── Helpers ──

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function stripModelPrefix(model: string): string {
  return model.replace(/^.*\//, "").replace(/^claude-/, "");
}

// ── Sub-components ──

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="si-row">
      <span className="si-row-label">{label}</span>
      <span className="si-row-value">{value}</span>
    </div>
  );
}

// ── Component ──

export default function SessionInfoWidget() {
  const { activeSession, serverSessions } = useSession();
  const { profiles, activeUP, selectedProfile } = useProfiles();
  const [now, setNow] = useState(Date.now());

  const status = activeSession?.status;

  // Tick every second while session is running so duration stays live
  useEffect(() => {
    if (status !== "running" && status !== "starting") return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [status]);

  if (!activeSession || activeSession.id.startsWith("pending-")) {
    return <WidgetEmptyState>no active session</WidgetEmptyState>;
  }

  const activeProfileName = activeSession.profile ?? selectedProfile;
  const profileData = profiles.find((p) => p.name === activeProfileName);
  const activeSessionInfo = serverSessions.find((s) => s.id === activeSession.id);

  const liveProvider =
    activeSessionInfo?.provider ||
    activeSession.provider ||
    profileData?.provider ||
    activeUP?.provider;
  const liveModel =
    activeSession.model || profileData?.model || activeUP?.model;

  const duration = activeSession.createdAt
    ? fmtDuration(now - activeSession.createdAt)
    : null;
  const msgCount = activeSession.messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  ).length;
  const cost = activeSession.totalCost ?? 0;

  // Token stats — sum across all turns (SDK reports per-turn aggregates across all internal API calls)
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
  let lastCacheWrite = 0, contextWindow = 0;
  for (const m of activeSession.messages) {
    totalInput += m.meta?.inputTokens ?? 0;
    totalOutput += m.meta?.outputTokens ?? 0;
    totalCacheRead += m.meta?.cacheReadTokens ?? 0;
    totalCacheWrite += m.meta?.cacheWriteTokens ?? 0;
    // Track last turn's cache write = current conversation size in cache
    if (m.meta?.cacheWriteTokens) lastCacheWrite = m.meta.cacheWriteTokens;
    if (m.meta?.contextWindow) contextWindow = m.meta.contextWindow;
  }
  const totalIn = totalInput + totalCacheRead + totalCacheWrite;
  const hasTokens = totalIn > 0 || totalOutput > 0;
  const ctxPct = contextWindow > 0 && lastCacheWrite > 0
    ? Math.round((lastCacheWrite / contextWindow) * 100)
    : null;

  return (
    <div className="si-widget">
      <div className="si-status-row">
        <span className={`si-dot si-dot--${status}`} />
        <span className={`si-status-text si-status-text--${status}`}>
          {status}
        </span>
      </div>

      <div className="si-rows">
        {activeProfileName && <Row label="profile" value={activeProfileName} />}
        {liveProvider && <Row label="provider" value={liveProvider} />}
        {liveModel && <Row label="model" value={stripModelPrefix(liveModel)} />}
        <Row label="messages" value={String(msgCount)} />
        {hasTokens && <Row label="tokens in" value={fmtNum(totalIn)} />}
        {hasTokens && <Row label="tokens out" value={fmtNum(totalOutput)} />}
        {totalCacheRead > 0 && <Row label="cache read" value={fmtNum(totalCacheRead)} />}
        {ctxPct !== null && (
          <Row label="context" value={`${fmtNum(lastCacheWrite)} / ${fmtNum(contextWindow)} (${ctxPct}%)`} />
        )}
        {cost > 0 && <Row label="cost" value={fmtCost(cost)} />}
        {duration && <Row label="duration" value={duration} />}
      </div>
    </div>
  );
}

