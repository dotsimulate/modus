/**
 * Session Info widget — metadata for the active chat session.
 *
 * Config example (in user profile dashboard.widgets or LeftPanel widgets prop):
 *   { "id": "session-info-left", "type": "session-info" }
 */

import { useState, useEffect } from "react";
import { useSession } from "../providers/SessionProvider";
import { useProfiles } from "../providers/ProfileProvider";
import { fmtCost } from "../utils/format";
import type { WidgetDef } from "./index";
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

function SessionInfoWidget() {
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
        {cost > 0 && <Row label="cost" value={fmtCost(cost)} />}
        {duration && <Row label="duration" value={duration} />}
      </div>
    </div>
  );
}

// ── Widget definition ──

const def: WidgetDef = { type: "session-info", component: SessionInfoWidget };
export default def;
