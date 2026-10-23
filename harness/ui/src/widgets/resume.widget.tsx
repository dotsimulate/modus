/**
 * Resume widget — take over conversations started outside Modus.
 *
 * Config: { "type": "resume" }
 *
 * One tab per provider with a local conversation store (Claude Code, Codex).
 * Each lists that provider's own sessions, newest first, wherever they were
 * started: the CLI, another desktop app, an IDE. Resuming one creates a Modus
 * session that continues the same native conversation in its original project
 * folder, so the CLI and any other front end still see the continued thread.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { modus } from "../modusClient";
import { ModusError, type ExternalSessionProvider, type ExternalSessionSummary } from "../../../sdk/index";
import { useFolderChooser } from "../hooks/usePathChooser";
import { useProfiles } from "../providers/ProfileContext";
import { useSessionActions } from "../providers/SessionContext";
import { timeAgo } from "../utils/format";
import type { WidgetBase, WidgetProps } from "./types";
import { useWidgetUiState } from "./ui-state";
import { WidgetEmptyState } from "./widget-components";

type ResumeConfig = WidgetBase & {
  type: "resume";
};

const PROVIDER_LABELS: Record<ExternalSessionProvider, string> = {
  "claude-code": "claude",
  codex: "codex",
};

const UI_SCOPE = { cwd: "global" };

function folderName(path: string | null): string {
  if (!path) return "";
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The server's `{ error }` body, not the status line wrapped around it. */
function errorText(err: unknown): string {
  if (err instanceof ModusError) {
    try {
      const parsed = JSON.parse(err.detail);
      if (typeof parsed?.error === "string") return parsed.error;
    } catch { /* not JSON */ }
    return err.detail || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export default function ResumeWidget({ widgetId, onSelectSession, pageContext }: WidgetProps<ResumeConfig>) {
  const { activeUserProfile } = useProfiles();
  const { refreshSessions } = useSessionActions();
  const folder = useFolderChooser();

  const scope = useMemo(() => ({ ...UI_SCOPE, userProfile: activeUserProfile }), [activeUserProfile]);
  const [provider, setProvider] = useWidgetUiState<ExternalSessionProvider>(scope, widgetId, "provider", "claude-code");
  const [cwdFilter, setCwdFilter] = useWidgetUiState<string>(scope, widgetId, "cwd", "");
  const [hideKnown, setHideKnown] = useWidgetUiState<boolean>(scope, widgetId, "hide-known", true);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  const [available, setAvailable] = useState<ExternalSessionProvider[] | null>(null);
  const [sessions, setSessions] = useState<ExternalSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    modus.listExternalSessionProviders()
      .then((providers) => {
        if (!alive) return;
        const present = providers.filter((p) => p.available).map((p) => p.provider);
        setAvailable(present);
        if (present.length > 0 && !present.includes(provider)) setProvider(present[0]!);
      })
      .catch((err) => { if (alive) { setAvailable([]); setError(errorText(err)); } });
    return () => { alive = false; };
    // Provider availability is read once; switching tabs must not refetch it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce typing so each keystroke does not rescan transcripts.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!available?.includes(provider)) return;
    let alive = true;
    setLoading(true);
    setError("");
    modus.listExternalSessions({
      provider,
      cwd: cwdFilter || undefined,
      q: query || undefined,
      hideKnown,
      limit: 100,
    })
      .then((list) => { if (alive) setSessions(list); })
      .catch((err) => { if (alive) { setSessions([]); setError(errorText(err)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [available, provider, cwdFilter, query, hideKnown, reloadKey]);

  // On a page, publish the selection and let the page decide; elsewhere navigate.
  const openSession = useCallback((id: string) => {
    if (pageContext) {
      pageContext.emit({ type: "select-session", sessionId: id });
    } else {
      onSelectSession(id);
    }
  }, [pageContext, onSelectSession]);

  const resume = useCallback(async (session: ExternalSessionSummary) => {
    if (session.modusSessionId) {
      openSession(session.modusSessionId);
      return;
    }
    setBusyId(session.id);
    setError("");
    try {
      const result = await modus.importExternalSession(session.provider, session.id, activeUserProfile ?? undefined);
      await refreshSessions();
      openSession(result.sessionId);
      setReloadKey((key) => key + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyId(null);
    }
  }, [activeUserProfile, refreshSessions, openSession]);

  const chooseFolder = () => folder.open({
    title: "Show sessions from this folder",
    initialPath: cwdFilter || undefined,
    onSelect: (path) => setCwdFilter(path),
  });

  if (available === null) return <WidgetEmptyState>loading...</WidgetEmptyState>;
  if (available.length === 0) {
    return <WidgetEmptyState>{error || "no Claude Code or Codex sessions found on this machine"}</WidgetEmptyState>;
  }

  return (
    <div className="rsw-widget">
      <div className="rsw-tabs">
        {available.map((name) => (
          <button
            key={name}
            className={`rsw-tab${provider === name ? " rsw-tab--active" : ""}`}
            onClick={() => setProvider(name)}
          >
            {PROVIDER_LABELS[name]}
          </button>
        ))}
        <button
          className="rsw-icon-btn"
          onClick={() => setReloadKey((key) => key + 1)}
          disabled={loading}
          title="Reload"
        >
          ↻
        </button>
      </div>

      <div className="rsw-toolbar">
        <input
          className="rsw-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search..."
          spellCheck={false}
        />
        <div className="rsw-filters">
          <button
            className={`rsw-chip${cwdFilter ? " rsw-chip--set" : ""}`}
            onClick={chooseFolder}
            disabled={folder.busy}
            title={cwdFilter || "Only show sessions from one folder"}
          >
            {cwdFilter ? folderName(cwdFilter) : "all folders"}
          </button>
          {cwdFilter && (
            <button className="rsw-chip" onClick={() => setCwdFilter("")} title="Show every folder">
              ×
            </button>
          )}
          <label className="rsw-toggle" title="Leave out conversations Modus already has">
            <input type="checkbox" checked={hideKnown} onChange={(e) => setHideKnown(e.target.checked)} />
            hide modus
          </label>
        </div>
        {folder.inline}
      </div>

      {error && <div className="rsw-error">{error}</div>}

      <div className="rsw-list">
        {!loading && sessions.length === 0 && !error && (
          <div className="rsw-empty">no sessions{cwdFilter ? " in this folder" : ""}{query ? " match" : ""}</div>
        )}
        {sessions.map((session) => {
          const busy = busyId === session.id;
          const action = session.modusSessionId ? "open" : "resume";
          return (
            <div key={session.id} className="rsw-row">
              <div className="rsw-row-main">
                <div className="rsw-title" title={session.title}>{session.title}</div>
                <div className="rsw-meta">
                  {session.cwd && <span title={session.cwd}>{folderName(session.cwd)}</span>}
                  <span>{timeAgo(session.updatedAt)}</span>
                  {session.source && <span>{session.source}</span>}
                  {session.modusSessionId && <span className="rsw-badge">in modus</span>}
                </div>
                {session.recentlyActive && !session.modusSessionId && (
                  <div
                    className="rsw-warn"
                    title="Written in the last two minutes. If another app still has it open, close it there first so two apps don't append to it at once."
                  >
                    active elsewhere? close it there first
                  </div>
                )}
              </div>
              <button
                className="rsw-action"
                onClick={() => void resume(session)}
                disabled={busy || busyId !== null}
              >
                {busy ? "..." : action}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
