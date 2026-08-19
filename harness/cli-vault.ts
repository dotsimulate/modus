import { join } from "path";
import { normalizeInstanceName } from "./app-paths";

export type VaultStateFiles = {
  pidFile: string;
  portFile: string;
};

function requireVaultRoot(vault: string | null, vaultRoot?: string): string | null {
  if (!vault) return null;
  if (!vaultRoot) throw new Error(`Vault "${vault}" is missing its registered folder root`);
  return vaultRoot;
}

function flagInstance(args: string[]): { present: boolean; value?: string } {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--instance=")) {
      return { present: true, value: arg.slice("--instance=".length) };
    }
    if (arg === "--instance") {
      const value = args[index + 1];
      return { present: true, value: value && !value.startsWith("-") ? value : undefined };
    }
  }
  return { present: false };
}

/** Resolve the process-level Vault selected by CLI args or MODUS_INSTANCE. */
export function resolveCliVault(args: string[], environmentValue?: string): string | null {
  const flag = flagInstance(args);
  if (flag.present && !flag.value?.trim()) {
    throw new Error("--instance requires a Vault slug");
  }
  const value = (flag.present ? flag.value : environmentValue)?.trim() ?? "";
  if (!value) return null;
  const normalized = normalizeInstanceName(value);
  if (!normalized) throw new Error(`Invalid Vault slug "${value}"`);
  return normalized === "default" ? null : normalized;
}

/** CLI process state is one PID/port pair per Vault. */
export function vaultStateFiles(
  configDir: string,
  vault: string | null,
  vaultRoot?: string,
): VaultStateFiles {
  const runtimeDir = vault ? join(requireVaultRoot(vault, vaultRoot)!, "runtime") : configDir;
  return {
    pidFile: join(runtimeDir, "harness.pid"),
    portFile: join(runtimeDir, "harness.port"),
  };
}

/** Authentication material follows the process state into the selected Vault. */
export function vaultTokenFile(configDir: string, vault: string | null, vaultRoot?: string): string {
  const runtimeDir = vault ? join(requireVaultRoot(vault, vaultRoot)!, "runtime") : configDir;
  return join(runtimeDir, "harness-token");
}

/** Build a child environment whose Vault cannot drift from the CLI selection. */
export function vaultEnvironment(
  parent: Record<string, string | undefined>,
  vault: string | null,
  vaultRoot?: string,
): Record<string, string | undefined> {
  const env = { ...parent };
  if (vault) {
    const root = requireVaultRoot(vault, vaultRoot)!;
    env.MODUS_INSTANCE = vault;
    env.MODUS_VAULT_ROOT = root;
    env.MODUS_HOME = root;
    env.HARNESS_SECRETS_FILE = join(root, "secrets.env");
    delete env.MODUS_DATA_DIR;
    delete env.MODUS_LOGS_DIR;
    delete env.MODUS_RUNTIME_DIR;
    delete env.MODUS_CACHE_DIR;
  } else {
    delete env.MODUS_INSTANCE;
    delete env.MODUS_VAULT_ROOT;
  }
  return env;
}

/** Keep the legacy default daemon log while putting named logs under their roots. */
export function vaultDaemonLogFile(
  defaultLogFile: string,
  vault: string | null,
  vaultRoot?: string,
): string {
  return vault ? join(requireVaultRoot(vault, vaultRoot)!, "logs", "harness.log") : defaultLogFile;
}
