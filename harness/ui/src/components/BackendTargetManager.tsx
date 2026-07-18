import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BACKEND_TARGET } from "../backendTarget";
import {
  activateBackendTarget,
  backendIdentityChanged,
  inspectBackendTarget,
  isDesktopClient,
  loadBackendTargets,
  rememberBackendConnected,
  removeBackendTarget,
  saveRemoteBackendTarget,
  type SavedBackendTarget,
} from "../backend-targets";

function targetSubtitle(target: SavedBackendTarget): string {
  if (target.id === "local") return "Daemon on this computer · ports 3777–3781";
  if (!target.lastConnectedAt) return target.url ?? "";
  return `${target.url} · used ${new Date(target.lastConnectedAt).toLocaleDateString()}`;
}

function BackendTargetPanel({ onClose, embedded = false }: { onClose?: () => void; embedded?: boolean }) {
  const [targets, setTargets] = useState(() => loadBackendTargets());
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentId = BACKEND_TARGET.id;

  const connect = async (target: SavedBackendTarget) => {
    setError(null);
    setConnectingId(target.id);
    if (target.id === "local") {
      activateBackendTarget(target);
      return;
    }
    const probe = await inspectBackendTarget(target.url!);
    if (!probe) {
      setConnectingId(null);
      setError(`Could not reach ${target.url}. Check Tailscale Serve and the daemon.`);
      return;
    }
    if (backendIdentityChanged(target.backendId, probe.backendId)) {
      setConnectingId(null);
      setError(`Backend identity changed for ${target.url}. Forget and add it again only if you intended to replace that daemon.`);
      return;
    }
    const connected = { ...target, ...(probe.backendId ? { backendId: probe.backendId } : {}) };
    rememberBackendConnected(connected);
    activateBackendTarget(connected);
  };

  const addAndConnect = async () => {
    setError(null);
    let target: SavedBackendTarget;
    try {
      target = saveRemoteBackendTarget(label, url);
      setTargets(loadBackendTargets());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    await connect(target);
  };

  const remove = (target: SavedBackendTarget) => {
    removeBackendTarget(target.id);
    setTargets(loadBackendTargets());
  };

  return (
    <div className={`backend-target-panel${embedded ? " embedded" : ""}`}>
      <div className="backend-target-header">
        <div>
          <div className="backend-target-title">Modus backend</div>
          <div className="backend-target-copy">Choose where sessions, files, terminals, and providers run.</div>
        </div>
        {onClose && <button type="button" className="backend-target-close" onClick={onClose} aria-label="Close">×</button>}
      </div>

      <div className="backend-target-list">
        {targets.map((target) => {
          const active = target.id === currentId || (target.id === "local" && BACKEND_TARGET.mode === "external-local");
          return (
            <div className={`backend-target-row${active ? " active" : ""}`} key={target.id}>
              <button type="button" className="backend-target-select" onClick={() => void connect(target)} disabled={!!connectingId}>
                <span className="backend-target-row-main">
                  <span className="backend-target-name">{target.label}</span>
                  {active && <span className="backend-target-active">current</span>}
                </span>
                <span className="backend-target-subtitle">{targetSubtitle(target)}</span>
              </button>
              {target.id !== "local" && (
                <button type="button" className="backend-target-remove" onClick={() => remove(target)} title="Forget backend">×</button>
              )}
              {connectingId === target.id && <span className="backend-target-working">connecting…</span>}
            </div>
          );
        })}
      </div>

      <div className="backend-target-add">
        <div className="backend-target-section-label">Add remote backend</div>
        <label>
          <span>Name</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Remote Modus" />
        </label>
        <label>
          <span>Tailscale URL</span>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void addAndConnect(); }}
            placeholder="https://modus-host.tailnet-name.ts.net"
            inputMode="url"
          />
        </label>
        <div className="backend-target-hint">Use the stable HTTPS address from Tailscale Serve. Authentication stays separate for every backend.</div>
        <button type="button" className="backend-target-connect" disabled={!url.trim() || !!connectingId} onClick={() => void addAndConnect()}>
          test and connect
        </button>
      </div>

      {error && <div className="backend-target-error">{error}</div>}
    </div>
  );
}

export function BackendTargetDialog({ onClose }: { onClose: () => void }) {
  return createPortal(
    <div className="backend-target-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <BackendTargetPanel onClose={onClose} />
    </div>,
    document.body,
  );
}

export function BackendTargetControl({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const enabled = useMemo(() => isDesktopClient(), []);
  if (!enabled) return null;
  return (
    <>
      <button
        type="button"
        className={`backend-target-control${compact ? " compact" : ""}`}
        onClick={() => setOpen(true)}
        title={`${BACKEND_TARGET.label} · ${BACKEND_TARGET.apiBase}`}
      >
        <span className="backend-target-control-dot" />
        <span>{BACKEND_TARGET.label}</span>
      </button>
      {open && <BackendTargetDialog onClose={() => setOpen(false)} />}
    </>
  );
}

export function BackendConnectionScreen({ message }: { message: string }) {
  return (
    <div className="backend-connection-screen">
      <div className="backend-connection-shell">
        <div className="backend-connection-message">{message}</div>
        <BackendTargetPanel embedded />
        <button type="button" className="backend-target-retry" onClick={() => window.location.reload()}>retry current target</button>
      </div>
    </div>
  );
}
