import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { VaultListItem, VaultPolicy } from "../../../sdk/types";
import { BACKEND_TARGET } from "../backendTarget";
import {
  activateBackendTarget,
  LOCAL_BACKEND_TARGET,
  managedVaultBackendTarget,
  rememberBackendConnected,
} from "../backend-targets";
import {
  bindManagedDesktopTarget,
  getDesktopVaultStatus,
  openDesktopVault,
  type DesktopVaultStatus,
} from "../desktopBridge";
import { modus } from "../modusClient";
import {
  deriveVaultSlug,
  normalizeVaultSlug,
  vaultDisplayName,
  vaultPolicyReceipt,
  vaultTargetId,
} from "../vault-targets";

type VaultView = VaultListItem & {
  status?: DesktopVaultStatus;
  policy?: VaultPolicy;
};

type Props = {
  onError: (message: string | null) => void;
};

export function DesktopVaultManager({ onError }: Props) {
  const [vaults, setVaults] = useState<VaultView[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [creating, setCreating] = useState(false);
  const [autostartWorking, setAutostartWorking] = useState<string | null>(null);
  const [openingVault, setOpeningVault] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await modus.listVaults();
      const enriched = await Promise.all(response.vaults.map(async (vault): Promise<VaultView> => {
        const [status, policy] = await Promise.all([
          getDesktopVaultStatus(vault.slug),
          modus.getVaultPolicy(vault.slug),
        ]);
        return { ...vault, status, policy };
      }));
      setVaults(enriched);
      onError(null);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    const pending = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(pending);
  }, [refresh]);

  const validSlug = useMemo(() => normalizeVaultSlug(slug), [slug]);

  const switchVault = async (vault: VaultListItem) => {
    const id = vaultTargetId(vault.slug);
    if (id === BACKEND_TARGET.id) return;
    const displayName = vaultDisplayName(vault.slug, vault.name);
    onError(null);
    setOpeningVault(displayName);
    try {
      const response = await openDesktopVault(vault.slug);
      await bindManagedDesktopTarget(response);
      const target = vault.slug
        ? { ...managedVaultBackendTarget(vault.slug, displayName), url: response.apiBase }
        : { ...LOCAL_BACKEND_TARGET, url: response.apiBase };
      rememberBackendConnected(target);
      activateBackendTarget(target);
    } catch (cause) {
      setOpeningVault(null);
      setCreating(false);
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const createAndEnter = async () => {
    if (!validSlug) return;
    setCreating(true);
    onError(null);
    try {
      const created = await modus.createVault(validSlug, name.trim() || undefined);
      await switchVault(created);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  };

  const setAutostart = async (vault: VaultListItem, enabled: boolean) => {
    if (!vault.slug) return;
    setAutostartWorking(vault.slug);
    onError(null);
    try {
      await modus.updateVault(vault.slug, { autostart: enabled });
      await refresh();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAutostartWorking(null);
    }
  };

  return (
    <>
      <section className="backend-vaults">
        <div className="backend-target-section-label">Local Vaults</div>
        <div className="backend-target-hint backend-vaults-intro">
          A Vault selects a separate local database and runtime. It is isolation by configuration, not encryption or an OS sandbox.
        </div>
        {loading && vaults.length === 0 ? (
          <div className="backend-vault-loading">loading Vaults…</div>
        ) : (
          <div className="backend-vault-list">
            {vaults.map((vault) => {
              const id = vaultTargetId(vault.slug);
              const viewing = BACKEND_TARGET.id === id;
              const name = vaultDisplayName(vault.slug, vault.name);
              return (
                <div className={`backend-vault-row${viewing ? " active" : ""}`} key={id}>
                  <button
                    type="button"
                    className="backend-vault-select"
                    disabled={!!openingVault}
                    onClick={() => void switchVault(vault)}
                  >
                    <span className="backend-target-row-main">
                      <span className="backend-target-name">{name}</span>
                      {viewing && <span className="backend-target-active">viewing</span>}
                      {vault.status?.running && <span className="backend-vault-state">running</span>}
                      {vault.autostart && <span className="backend-vault-state">autostart</span>}
                    </span>
                    <span className="backend-target-subtitle">
                      {vault.slug ? vault.slug : "implicit default Vault"}
                    </span>
                  </button>
                  {vault.slug && (
                    <label className="backend-vault-autostart">
                      <input
                        type="checkbox"
                        checked={!!vault.autostart}
                        disabled={autostartWorking === vault.slug}
                        onChange={(event) => void setAutostart(vault, event.target.checked)}
                      />
                      start with Modus
                    </label>
                  )}
                  <details className="backend-vault-details">
                    <summary>local details</summary>
                    <div className="backend-vault-path">{vault.status?.databasePath ?? "Path unavailable"}</div>
                    <div>{vault.policy ? vaultPolicyReceipt(vault.policy) : "Policy unavailable."}</div>
                    <div>This location is deterministic and visible; it is not encrypted or secret.</div>
                  </details>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="backend-vault-create">
        <div className="backend-target-section-label">Create restricted Vault</div>
        <label>
          <span>Name</span>
          <input
            value={name}
            onChange={(event) => {
              const next = event.target.value;
              setName(next);
              if (!slugEdited) setSlug(deriveVaultSlug(next));
            }}
            placeholder="Private work"
          />
        </label>
        <label>
          <span>Slug</span>
          <input
            value={slug}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value);
            }}
            placeholder="private-work"
            spellCheck={false}
          />
        </label>
        <div className={`backend-vault-receipt${slug && !validSlug ? " invalid" : ""}`}>
          {slug && !validSlug
            ? "Use lowercase letters, numbers, dots, underscores, or hyphens; default is reserved."
            : "New named Vaults deny plugins, project automation, and channels by default. Creation does not add encryption or OS sandboxing."}
        </div>
        <button
          type="button"
          className="backend-target-connect"
          disabled={!name.trim() || !validSlug || creating || !!openingVault}
          onClick={() => void createAndEnter()}
        >
          {creating ? "creating…" : "create, start, and enter"}
        </button>
      </section>

      {openingVault && createPortal(
        <div className="backend-vault-opening" role="status" aria-live="polite">
          <div>
            <span className="backend-target-control-dot" />
            opening Vault…
            <strong>{openingVault}</strong>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
