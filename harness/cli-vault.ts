import { join } from "path";
import { isValidInstanceName } from "./app-paths";

export type VaultStateFiles = {
  pidFile: string;
  portFile: string;
};

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
  if (!value || value === "default") return null;
  if (!isValidInstanceName(value)) throw new Error(`Invalid Vault slug "${value}"`);
  return value;
}

/** CLI process state is one PID/port pair per Vault. */
export function vaultStateFiles(configDir: string, vault: string | null): VaultStateFiles {
  const qualifier = vault ? `.${vault}` : "";
  return {
    pidFile: join(configDir, `harness${qualifier}.pid`),
    portFile: join(configDir, `harness${qualifier}.port`),
  };
}

/** Build a child environment whose Vault cannot drift from the CLI selection. */
export function vaultEnvironment(
  parent: Record<string, string | undefined>,
  vault: string | null,
): Record<string, string | undefined> {
  const env = { ...parent };
  if (vault) env.MODUS_INSTANCE = vault;
  else delete env.MODUS_INSTANCE;
  return env;
}

/** Keep the legacy default daemon log while preventing named-Vault log mixing. */
export function vaultDaemonLogFile(
  defaultLogFile: string,
  vaultLogsDir: string,
  vault: string | null,
): string {
  return vault ? join(vaultLogsDir, "harness.log") : defaultLogFile;
}
