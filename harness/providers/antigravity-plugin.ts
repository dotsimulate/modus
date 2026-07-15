import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { MODUS_HOME } from "../modus-home";
import { runAntigravityCommand } from "./antigravity-cli-runtime";

export const MODUS_ANTIGRAVITY_PLUGIN = "modus-provider";

let setupPromise: Promise<void> | null = null;

function shellQuote(value: string, platform = process.platform): string {
  if (platform === "win32") return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function antigravityPluginFiles(options: {
  bunPath?: string;
  providersDir?: string;
  platform?: NodeJS.Platform;
} = {}): Record<string, string> {
  const bunPath = options.bunPath ?? process.execPath;
  const providersDir = options.providersDir ?? import.meta.dir;
  const platform = options.platform ?? process.platform;
  const hookScript = join(providersDir, "antigravity-hook.ts");
  const bridgeScript = join(providersDir, "antigravity-mcp-bridge.ts");
  const hookCommand = (mode: string) => [bunPath, hookScript, mode].map((part) => shellQuote(part, platform)).join(" ");
  const hookHandler = (mode: string) => ({
    type: "command",
    command: hookCommand(mode),
    timeout: 82_800,
  });

  return {
    "plugin.json": JSON.stringify({
      $schema: "https://antigravity.google/schemas/v1/plugin.json",
      name: MODUS_ANTIGRAVITY_PLUGIN,
      description: "Modus session identity, tool lifecycle, approval, and profile MCP bridge for Antigravity CLI.",
    }, null, 2),
    "hooks.json": JSON.stringify({
      "modus-provider-observer": {
        PreInvocation: [hookHandler("pre-invocation")],
        PreToolUse: [{ matcher: "*", hooks: [hookHandler("pre-tool")] }],
        PostToolUse: [{ matcher: "*", hooks: [hookHandler("post-tool")] }],
        Stop: [hookHandler("stop")],
      },
    }, null, 2),
    "mcp_config.json": JSON.stringify({
      mcpServers: {
        modus_profile_tools: {
          command: bunPath,
          args: [bridgeScript],
        },
      },
    }, null, 2),
  };
}

function writePluginDirectory(directory: string, files: Record<string, string>): void {
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(directory, name), `${content}\n`, "utf8");
  }
}

/**
 * Install and enable the small Modus-owned plugin through Antigravity's public
 * plugin command. Existing user plugins and settings are never modified.
 */
export function ensureAntigravityPlugin(executable: string): Promise<void> {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    const files = antigravityPluginFiles();
    const sourceDir = join(MODUS_HOME, "runtime", "antigravity", MODUS_ANTIGRAVITY_PLUGIN);
    writePluginDirectory(sourceDir, files);

    // `plugin install <path>` is idempotent and refreshes an existing import.
    // Keeping this at the public CLI boundary avoids depending on Antigravity's
    // platform/version-specific internal staging directories.
    const installed = await runAntigravityCommand(executable, ["plugin", "install", sourceDir], { timeoutMs: 30_000 });
    if (installed.exitCode !== 0 || /error:/i.test(`${installed.stdout}\n${installed.stderr}`)) {
      throw new Error(`Could not install the ${MODUS_ANTIGRAVITY_PLUGIN} Antigravity plugin: ${installed.stderr.trim() || installed.stdout.trim() || `exit ${installed.exitCode}`}`);
    }

    const enabled = await runAntigravityCommand(executable, ["plugin", "enable", MODUS_ANTIGRAVITY_PLUGIN], { timeoutMs: 15_000 });
    const enabledText = `${enabled.stdout}\n${enabled.stderr}`;
    if ((enabled.exitCode !== 0 || /error:/i.test(enabledText)) && !/already enabled/i.test(enabledText)) {
      throw new Error(`Could not enable the ${MODUS_ANTIGRAVITY_PLUGIN} Antigravity plugin: ${enabled.stderr.trim() || enabled.stdout.trim() || `exit ${enabled.exitCode}`}`);
    }
  })().catch((error) => {
    setupPromise = null;
    throw error;
  });
  return setupPromise;
}

export function resetAntigravityPluginSetupForTests(): void {
  setupPromise = null;
}
