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
  chooseDesktopVaultFolder,
  createDesktopVault,
  getDesktopVaultPolicy,
  getDesktopVaultStatus,
  listDesktopVaults,
  openDesktopVault,
  repairDesktopVault,
  updateDesktopVault,
  type DesktopVaultStatus,
} from "../desktopBridge";
import {
  deriveVaultSlug,
  vaultDisplayName,
  vaultPolicyReceipt,
  vaultRegistrationState,
  vaultTargetId,
  type VaultFolderMode,
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
  const [root, setRoot] = useState("");
  const [mode, setMode] = useState<VaultFolderMode>("initialize");
  const [repairing, setRepairing] = useState<VaultListItem | null>(null);
  const [slugEdited, setSlugEdited] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [creating, setCreating] = useState(false);
  const [autostartWorking, setAutostartWorking] = useState<string | null>(null);
  const [openingVault, setOpeningVault] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await listDesktopVaults();
      const enriched = await Promise.all(response.vaults.map(async (vault): Promise<VaultView> => {
        if (vault.requiresRepair) return vault;
        const [status, policy] = await Promise.all([
          getDesktopVaultStatus(vault.slug).catch(() => undefined),
          getDesktopVaultPolicy(vault.slug).catch(() => undefined),
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

  const registration = useMemo(() => vaultRegistrationState({
    name,
    slug,
    root,
    mode,
    repair: !!repairing,
  }), [mode, name, repairing, root, slug]);

  const switchVault = async (vault: VaultListItem) => {
    if (vault.requiresRepair) return;
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

  const chooseFolder = async () => {
    setChoosingFolder(true);
    onError(null);
    try {
      const selected = await chooseDesktopVaultFolder();
      if (selected) setRoot(selected);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChoosingFolder(false);
    }
  };

  const resetForm = () => {
    setName("");
    setSlug("");
    setRoot("");
    setMode("initialize");
    setRepairing(null);
    setSlugEdited(false);
  };

  const beginRepair = (vault: VaultListItem) => {
    if (!vault.slug) return;
    setRepairing(vault);
    setName(vault.name ?? "");
    setSlug(vault.slug);
    setRoot("");
    setMode("initialize");
    setSlugEdited(true);
    onError(null);
  };

  const registerAndEnter = async () => {
    if (!registration.ready || !registration.slug) return;
    setCreating(true);
    onError(null);
    try {
      const request = {
        slug: registration.slug,
        root: root.trim(),
        name: name.trim() || undefined,
        mode,
      };
      const created = repairing
        ? await repairDesktopVault(request)
        : await createDesktopVault(request);
      await switchVault({ ...created, slug: created.slug });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  };

  const setAutostart = async (vault: VaultListItem, enabled: boolean) => {
    if (!vault.slug || vault.requiresRepair) return;
    setAutostartWorking(vault.slug);
    onError(null);
    try {
      await updateDesktopVault(vault.slug, { autostart: enabled });
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
          Each named Vault keeps its complete Modus-managed config and data in a folder you choose. This is a configuration boundary, not encryption or an OS sandbox.
        </div>
        {loading && vaults.length === 0 ? (
          <div className="backend-vault-loading">loading Vaults...</div>
        ) : (
          <div className="backend-vault-list">
            {vaults.map((vault) => {
              const id = vaultTargetId(vault.slug);
              const viewing = BACKEND_TARGET.id === id;
              const displayName = vaultDisplayName(vault.slug, vault.name);
              return (
                <div className={`backend-vault-row${viewing ? " active" : ""}${vault.requiresRepair ? " invalid" : ""}`} key={id}>
                  <button
                    type="button"
                    className="backend-vault-select"
                    disabled={!!openingVault || !!vault.requiresRepair}
                    onClick={() => void switchVault(vault)}
                  >
                    <span className="backend-target-row-main">
                      <span className="backend-target-name">{displayName}</span>
                      {viewing && <span className="backend-target-active">viewing</span>}
                      {vault.status?.running && <span className="backend-vault-state">running</span>}
                      {vault.autostart && <span className="backend-vault-state">autostart</span>}
                      {vault.requiresRepair && <span className="backend-vault-state warning">folder required</span>}
                    </span>
                    <span className="backend-target-subtitle">
                      {vault.slug ? vault.slug : "implicit Main Vault"}
                    </span>
                  </button>
                  {vault.requiresRepair && vault.slug ? (
                    <button
                      type="button"
                      className="backend-vault-repair"
                      disabled={!!openingVault}
                      onClick={() => beginRepair(vault)}
                    >
                      repair
                    </button>
                  ) : vault.slug ? (
                    <label className="backend-vault-autostart">
                      <input
                        type="checkbox"
                        checked={!!vault.autostart}
                        disabled={autostartWorking === vault.slug}
                        onChange={(event) => void setAutostart(vault, event.target.checked)}
                      />
                      start with Modus
                    </label>
                  ) : null}
                  <details className="backend-vault-details">
                    <summary>local details</summary>
                    <div className="backend-vault-path">{vault.root ?? "Choose a folder to repair this registration."}</div>
                    {vault.status?.databasePath && <div>Database: {vault.status.databasePath}</div>}
                    <div>{vault.policy ? vaultPolicyReceipt(vault.policy) : vault.requiresRepair ? "Policy unavailable until repaired." : "Policy unavailable."}</div>
                    <div>The folder path is visible and local; it is not encrypted or secret.</div>
                  </details>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="backend-vault-create">
        <div className="backend-vault-create-heading">
          <div className="backend-target-section-label">
            {repairing ? `Repair ${vaultDisplayName(repairing.slug, repairing.name)}` : "Add restricted Vault"}
          </div>
          {repairing && <button type="button" onClick={resetForm}>cancel repair</button>}
        </div>
        <label>
          <span>Name</span>
          <input
            value={name}
            disabled={!!repairing}
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
            disabled={!!repairing}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value);
            }}
            placeholder="private-work"
            spellCheck={false}
          />
        </label>
        <label>
          <span>Folder</span>
          <span className="backend-vault-folder-control">
            <input value={root} readOnly placeholder="Choose a local folder" title={root} />
            <button type="button" disabled={choosingFolder} onClick={() => void chooseFolder()}>
              {choosingFolder ? "choosing..." : "choose..."}
            </button>
          </span>
        </label>
        <label>
          <span>Folder use</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as VaultFolderMode)}>
            <option value="initialize">Initialize an empty folder</option>
            <option value="register">Register an existing marked Vault</option>
          </select>
        </label>
        <div className={`backend-vault-receipt${registration.error ? " invalid" : ""}`}>
          {registration.error ?? (mode === "initialize"
            ? "The folder must be empty. Modus will add a Vault marker and a deny-all default policy."
            : "The folder must already contain a matching Modus Vault marker. Its contents are preserved.")}
        </div>
        <button
          type="button"
          className="backend-target-connect"
          disabled={!registration.ready || creating || !!openingVault}
          onClick={() => void registerAndEnter()}
        >
          {creating ? "working..." : registration.action}
        </button>
      </section>

      {openingVault && createPortal(
        <div className="backend-vault-opening" role="status" aria-live="polite">
          <div>
            <span className="backend-target-control-dot" />
            opening Vault...
            <strong>{openingVault}</strong>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
