import { useCallback, useEffect, useState } from "react";
import type { TerminalInfo } from "../../../sdk/index";
import { modus } from "../modusClient";
import { useProfiles } from "../providers/ProfileContext";
import { useSession } from "../providers/SessionContext";
import { timeAgo, basename } from "../utils/format";
import type { WidgetBase, WidgetProps } from "./types";
import { useWidgetChrome } from "./chrome";
import { useWidgetPollingValue } from "./widget-data";
import { WidgetEmptyState } from "./widget-components";

type TerminalsConfig = WidgetBase & {
  type: "terminals";
  mode?: "session" | "all";
  limit?: number;
};

function describeOwner(terminal: TerminalInfo): string {
  const kind = terminal.kind ?? "shell";
  const owner = terminal.ownerName ?? terminal.ownerType ?? kind;
  if (kind === "provider" && terminal.provider) return terminal.provider;
  return owner;
}

function describeMeta(terminal: TerminalInfo): string {
  const bits = [
    terminal.kind ?? "shell",
    terminal.interactive === false ? "read-only" : null,
    terminal.pid ? `pid ${terminal.pid}` : null,
    terminal.provider && terminal.kind !== "provider" ? terminal.provider : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

function describeOrigin(terminal: TerminalInfo): string {
  const ownerType = terminal.ownerType ?? (terminal.kind === "provider" ? "provider" : "terminal");
  const ownerName = describeOwner(terminal);
  if (ownerType === "provider") return `started by provider ${ownerName}`;
  if (ownerType === "move") return `started by move ${ownerName}`;
  if (ownerType === "session") return `started by session ${ownerName}`;
  if (ownerType === "user") return `started manually`;
  return `started by ${ownerName}`;
}

function describeLinkage(terminal: TerminalInfo, activeSessionId: string | null | undefined): string {
  if (!terminal.sessionId) return "detached from sessions";
  if (terminal.sessionId === activeSessionId) return "linked to this session";
  return `linked to session ${shortSessionId(terminal.sessionId)}`;
}

function describeControl(terminal: TerminalInfo): string {
  if (terminal.stopMode === "terminate") return "stop kills this shell";
  if (terminal.stopMode === "delegate") return "stop requests shutdown from its owner";
  return "observe only";
}

function describeStatus(terminal: TerminalInfo): string {
  return terminal.status ?? "running";
}

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 14) return sessionId;
  return `${sessionId.slice(0, 6)}…${sessionId.slice(-4)}`;
}

function buildSessionHref(sessionId: string, userProfile: string | null): string {
  const hash = userProfile ? `${userProfile}/${sessionId}` : sessionId;
  return `${window.location.origin}${window.location.pathname}#${hash}`;
}

export default function TerminalsWidget({ config, onSelectSession, pageContext }: WidgetProps<TerminalsConfig>) {
  const { activeSession } = useSession();
  const { activeUserProfile } = useProfiles();
  const { setHeaderSuffix } = useWidgetChrome();
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const mode = config.mode ?? "all";
  const limit = config.limit ?? 8;
  const sessionId = mode === "session" ? activeSession?.id ?? null : null;

  const load = useCallback(async () => {
    const rows = sessionId
      ? await modus.listTerminals(sessionId)
      : await modus.listTerminals();
    return {
      total: rows.length,
      items: rows.slice(0, limit),
    };
  }, [limit, sessionId]);

  const { value, loading } = useWidgetPollingValue<{ total: number; items: TerminalInfo[] }>({
    load,
    scopeKey: `terminals:${mode}:${sessionId ?? "all"}:${limit}`,
    intervalMs: 3000,
    initialValue: { total: 0, items: [] },
  });
  const terminals = value.items;

  useEffect(() => {
    if (!loading) setHeaderSuffix(`(${value.total})`);
  }, [loading, setHeaderSuffix, value.total]);

  useEffect(() => {
    return () => {
      setHeaderSuffix(null);
    };
  }, [setHeaderSuffix]);

  const handleStop = useCallback(async (terminalId: string) => {
    setStoppingId(terminalId);
    try {
      await modus.deleteTerminal(terminalId);
    } catch (err) {
      console.error("[terminals.widget] failed to stop terminal", terminalId, err);
    } finally {
      setStoppingId((current) => (current === terminalId ? null : current));
    }
  }, []);

  if (mode === "session" && !activeSession) {
    return <WidgetEmptyState>no active session</WidgetEmptyState>;
  }
  if (loading) {
    return <WidgetEmptyState>loading terminals...</WidgetEmptyState>;
  }
  if (terminals.length === 0) {
    return <WidgetEmptyState>{mode === "session" ? "no active terminals on this session" : "no active terminals"}</WidgetEmptyState>;
  }

  return (
    <div className="tmw-widget">
      {terminals.map((terminal) => {
        const owner = describeOwner(terminal);
        const cwdLabel = basename(terminal.cwd);
        const canJump = !!terminal.sessionId && terminal.sessionId !== activeSession?.id;
        const sessionHref = terminal.sessionId ? buildSessionHref(terminal.sessionId, activeUserProfile) : null;
        return (
          <div key={terminal.id} className="tmw-row">
            <div className="tmw-row-main">
              <div className="tmw-row-top">
                <span className="tmw-owner">{owner}</span>
                <span className={`tmw-status tmw-status--${describeStatus(terminal)}`}>{describeStatus(terminal)}</span>
                <span className={`tmw-kind tmw-kind--${terminal.kind ?? "shell"}`}>{terminal.kind ?? "shell"}</span>
                {terminal.sessionId ? (
                  <span className="tmw-session" title={terminal.sessionId}>session {shortSessionId(terminal.sessionId)}</span>
                ) : (
                  <span className="tmw-session tmw-session--detached">detached</span>
                )}
              </div>
              <div className="tmw-row-meta">
                <span>{describeMeta(terminal)}</span>
                {terminal.clients != null && <span>{terminal.clients} client{terminal.clients === 1 ? "" : "s"}</span>}
                {terminal.lastOutputAt && <span>output {timeAgo(terminal.lastOutputAt)}</span>}
              </div>
              <div className="tmw-row-meta">
                <span>{describeOrigin(terminal)}</span>
                <span>{describeLinkage(terminal, activeSession?.id)}</span>
                <span>{describeControl(terminal)}</span>
              </div>
              {cwdLabel && <div className="tmw-cwd" title={terminal.cwd ?? undefined}>{cwdLabel}</div>}
            </div>
            <div className="tmw-actions">
              {canJump && (
                <a
                  className="tmw-jump"
                  href={sessionHref ?? "#"}
                  onClick={(e) => {
                    e.preventDefault();
                    if (pageContext) { pageContext.set("selectedSession", terminal.sessionId!); } else { onSelectSession(terminal.sessionId!); }
                  }}
                  title={sessionHref ?? "Open session"}
                >
                  open
                </a>
              )}
              {terminal.canStop && (
                <button
                  className="tmw-stop"
                  onClick={() => { void handleStop(terminal.id); }}
                  disabled={stoppingId === terminal.id}
                  title={describeControl(terminal)}
                >
                  {stoppingId === terminal.id ? "stopping" : "stop"}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
