import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BACKEND_TARGET } from "../backendTarget";
import {
  getDesktopTailscaleStatus,
  isTauriRuntime,
  quitDesktopModus,
  setDesktopTailscaleEnabled,
  type DesktopTailscaleStatus,
} from "../desktopBridge";
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
import { DesktopVaultManager } from "./DesktopVaultManager";
import { modus } from "../modusClient";
import { vaultDisplayName } from "../vault-targets";

function targetSubtitle(target: SavedBackendTarget): string {
  if (target.id === "local") return "Managed by the desktop · OS-assigned private port";
  if (target.id === "external-local") return "Existing CLI daemon · ports 3777–3781";
  if (!target.lastConnectedAt) return target.url ?? "";
  return `${target.url} · used ${new Date(target.lastConnectedAt).toLocaleDateString()}`;
}

function BackendTargetPanel({ onClose, embedded = false }: { onClose?: () => void; embedded?: boolean }) {
  const [targets, setTargets] = useState(() => loadBackendTargets());
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tailscale, setTailscale] = useState<DesktopTailscaleStatus | null>(null);
  const [tailscaleWorking, setTailscaleWorking] = useState(false);
  const [confirmUnpinnedTailscale, setConfirmUnpinnedTailscale] = useState(false);
  const nativeDesktop = useMemo(() => isTauriRuntime(), []);

  const currentId = BACKEND_TARGET.id;
  const managedLocal = nativeDesktop && BACKEND_TARGET.mode === "managed-local";
  const managedMain = managedLocal && !BACKEND_TARGET.vaultSlug;
  const visibleTargets = managedLocal
    ? targets.filter((target) => target.mode !== "managed-local")
    : targets;

  useEffect(() => {
    if (!managedLocal) return;
    let cancelled = false;
    void getDesktopTailscaleStatus()
      .then((status) => { if (!cancelled) setTailscale(status); })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [managedLocal]);

  const configureTailscale = async (enabled: boolean) => {
    if (enabled && tailscale && !tailscale.enabled && !tailscale.pinConfigured && !confirmUnpinnedTailscale) {
      setConfirmUnpinnedTailscale(true);
      return;
    }
    setError(null);
    setTailscaleWorking(true);
    try {
      setTailscale(await setDesktopTailscaleEnabled(enabled));
      setConfirmUnpinnedTailscale(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTailscaleWorking(false);
    }
  };

  const connect = async (target: SavedBackendTarget) => {
    setError(null);
    setConnectingId(target.id);
    if (target.mode !== "remote") {
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
        {visibleTargets.map((target) => {
          const active = target.id === currentId;
          return (
            <div className={`backend-target-row${active ? " active" : ""}`} key={target.id}>
              <button type="button" className="backend-target-select" onClick={() => void connect(target)} disabled={!!connectingId}>
                <span className="backend-target-row-main">
                  <span className="backend-target-name">{target.label}</span>
                  {active && <span className="backend-target-active">current</span>}
                </span>
                <span className="backend-target-subtitle">{targetSubtitle(target)}</span>
              </button>
              {target.mode === "remote" && (
                <button type="button" className="backend-target-remove" onClick={() => remove(target)} title="Forget backend">×</button>
              )}
              {connectingId === target.id && <span className="backend-target-working">connecting…</span>}
            </div>
          );
        })}
      </div>

      {managedLocal && <DesktopVaultManager onError={setError} />}

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

      {managedMain && (
        <div className="backend-target-tailnet">
          <div className="backend-target-tailnet-heading">
            <div>
              <div className="backend-target-section-label">Phone and browser access · Main only</div>
              <div className="backend-target-tailnet-title">Tailscale Serve</div>
            </div>
            <span className={`backend-target-tailnet-state ${tailscale?.state ?? "loading"}`}>
              {tailscale?.state ?? "checking"}
            </span>
          </div>
          <div className="backend-target-hint">
            The desktop publishes this exact managed backend to your stable tailnet HTTPS address. Closing keeps it online; Quit removes the route.
          </div>
          {tailscale?.url && <div className="backend-target-tailnet-url">{tailscale.url}</div>}
          {tailscale?.message && <div className="backend-target-tailnet-message">{tailscale.message}</div>}
          {tailscale?.enabled && !tailscale.pinConfigured && (
            <div className="backend-target-tailnet-warning">Set a browser PIN before sharing this machine with other tailnet users.</div>
          )}
          {tailscale && !tailscale.enabled && !tailscale.pinConfigured && (
            <div className="backend-target-tailnet-warning">
              A browser PIN is recommended before Tailnet access. Without one, every tailnet peer that can reach this host is a full Modus operator. Configure it in Settings → Security, or confirm below.
            </div>
          )}
          <div className="backend-target-tailnet-actions">
            {!tailscale?.enabled ? (
              <>
                <button type="button" disabled={!tailscale || tailscaleWorking} onClick={() => void configureTailscale(true)}>
                  {tailscaleWorking ? "enabling…" : confirmUnpinnedTailscale ? "Confirm: enable without PIN" : "Enable Tailnet access"}
                </button>
                {confirmUnpinnedTailscale && (
                  <button type="button" disabled={tailscaleWorking} onClick={() => setConfirmUnpinnedTailscale(false)}>Cancel</button>
                )}
              </>
            ) : (
              <>
                {tailscale.state !== "active" && (
                  <button type="button" disabled={tailscaleWorking} onClick={() => void configureTailscale(true)}>
                    {tailscaleWorking ? "retrying…" : "Retry"}
                  </button>
                )}
                <button type="button" disabled={tailscaleWorking} onClick={() => void configureTailscale(false)}>
                  Turn off
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {nativeDesktop && (
        <div className="backend-target-lifecycle">
          <div>Closing the window hides Modus to the tray and keeps the managed backend running.</div>
          <button type="button" onClick={() => void quitDesktopModus()}>Quit Modus and stop backend</button>
        </div>
      )}

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
  const [identity, setIdentity] = useState(() => (
    BACKEND_TARGET.mode === "managed-local"
      ? `Vault · ${vaultDisplayName(BACKEND_TARGET.vaultSlug ?? null, BACKEND_TARGET.label)}`
      : BACKEND_TARGET.label
  ));
  const enabled = useMemo(() => isDesktopClient(), []);
  useEffect(() => {
    if (BACKEND_TARGET.mode !== "managed-local") return;
    let cancelled = false;
    void modus.listVaults().then((response) => {
      if (cancelled) return;
      const current = response.vaults.find((vault) => vault.slug === (BACKEND_TARGET.vaultSlug ?? null));
      setIdentity(`Vault · ${vaultDisplayName(
        current?.slug ?? BACKEND_TARGET.vaultSlug ?? null,
        current?.name ?? BACKEND_TARGET.label,
      )}`);
    }).catch(() => {
      // The target panel exposes connection errors; the identity badge stays useful offline.
    });
    return () => { cancelled = true; };
  }, []);
  if (!enabled) return null;
  return (
    <>
      <button
        type="button"
        className={`backend-target-control${compact ? " compact" : ""}`}
        onClick={() => setOpen(true)}
        title={`${identity} · ${BACKEND_TARGET.apiBase}`}
      >
        <span className="backend-target-control-dot" />
        <span>{identity}</span>
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
