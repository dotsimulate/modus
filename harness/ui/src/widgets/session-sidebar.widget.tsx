/**
 * Session Sidebar widget — metadata and stats for a session.
 *
 * Config: { "type": "session-sidebar", "id": "sb-1", "sessionId": "optional-id" }
 *
 * Shows session metadata: status, profile, model, token usage, cost, duration.
 */

import { useState, useEffect } from "react";
import { useSessionState, ensureSubscribed } from "../sessionStore";
import { fmtCost, fmtNum } from "../utils/format";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";

type SessionSidebarConfig = WidgetBase & {
  type: "session-sidebar";
  sessionId?: string;
};

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="si-row">
      <span className="si-row-label">{label}</span>
      <span className="si-row-value">{value}</span>
    </div>
  );
}

export default function SessionSidebarWidget({ config, pageContext }: WidgetProps<SessionSidebarConfig>) {
  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const sessionId = contextSessionId ?? config.sessionId ?? null;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (sessionId) void ensureSubscribed(sessionId);
  }, [sessionId]);

  const session = useSessionState(sessionId);
  const status = session?.status;

  // Tick while running
  useEffect(() => {
    if (status !== "running" && status !== "starting") return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [status]);

  if (!sessionId) {
    return <WidgetEmptyState>no session selected</WidgetEmptyState>;
  }

  if (!session) {
    return <WidgetEmptyState>loading session...</WidgetEmptyState>;
  }

  const messages = session.messages ?? [];
  const msgCount = messages.filter((m) => m.role === "user" || m.role === "assistant").length;
  const toolCalls = messages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);
  const cost = session.totalCost ?? 0;
  const duration = session.createdAt ? fmtDuration(now - session.createdAt) : null;

  // Token stats
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0;
  for (const m of messages) {
    totalInput += m.meta?.inputTokens ?? 0;
    totalOutput += m.meta?.outputTokens ?? 0;
    totalCacheRead += m.meta?.cacheReadTokens ?? 0;
  }
  const hasTokens = totalInput > 0 || totalOutput > 0;

  return (
    <div className="session-sidebar-widget si-widget">
      <div className="si-status-row">
        <span className={`si-dot si-dot--${status}`} />
        <span className={`si-status-text si-status-text--${status}`}>{status}</span>
      </div>

      <div className="si-rows">
        {session.profile && <Row label="profile" value={session.profile} />}
        {session.model && <Row label="model" value={session.model.replace(/^.*\//, "").replace(/^claude-/, "")} />}
        <Row label="messages" value={String(msgCount)} />
        {toolCalls > 0 && <Row label="tool calls" value={String(toolCalls)} />}
        {hasTokens && <Row label="tokens in" value={fmtNum(totalInput + totalCacheRead)} />}
        {hasTokens && <Row label="tokens out" value={fmtNum(totalOutput)} />}
        {totalCacheRead > 0 && <Row label="cache read" value={fmtNum(totalCacheRead)} />}
        {cost > 0 && <Row label="cost" value={fmtCost(cost)} />}
        {duration && <Row label="duration" value={duration} />}
        {session.cwd && <Row label="cwd" value={session.cwd.split("/").pop() ?? session.cwd} />}
      </div>
    </div>
  );
}
