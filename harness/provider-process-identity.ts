/**
 * Telling this harness's provider processes apart from everything else on the
 * machine that shares their executable name.
 *
 * `claude.exe` alone is ambiguous: it is the Claude Code CLI, the Claude
 * Desktop application and its renderer subprocesses, and any session the user
 * started in their own terminal. Orphan reporting attaches a kill control to
 * whatever it lists, so a match has to be positive evidence that Modus
 * launched the process — never a name alone.
 */

import { SENSITIVE_TEMP_PREFIX } from "./sensitive-temp";

/**
 * Image names a stranded provider process can run under.
 *
 * The Claude Code CLI used to be a `cli.js` script hosted by `node.exe`; since
 * 2.x it ships as a compiled `claude.exe`. Scanning only the old shape reports
 * zero orphans on every current install, which reads as "nothing stranded"
 * rather than "not looking".
 */
export const PROVIDER_ORPHAN_IMAGE_NAMES = ["node.exe", "claude.exe"];

/**
 * Whether a command line belongs to a provider process this harness launched.
 *
 * Each rule matches something only Modus puts on the command line:
 * the script path of the legacy Node-hosted CLI, an inline MCP configuration
 * addressed to this harness's port, or the path of launch material written
 * into a Modus-private temporary directory.
 */
export function isHarnessOwnedProviderCommand(commandLine: string, port: number): boolean {
  if (commandLine.includes("@anthropic-ai/claude-code/cli.js")
    || commandLine.includes("@anthropic-ai\\claude-code\\cli.js")) return true;
  if (commandLine.includes(`127.0.0.1:${port}/api/mcp/modus`)) return true;
  if (commandLine.includes(SENSITIVE_TEMP_PREFIX)) return true;
  return false;
}
