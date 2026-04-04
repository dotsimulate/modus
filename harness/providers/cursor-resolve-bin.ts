/**
 * Resolve cursor-agent executable for health checks, model listing, and spawn.
 * Windows: prefer CURSOR_AGENT_BIN (full path) when the installer did not update PATH for your harness process.
 */

import { existsSync } from "fs";

/** Raw argv[0] from env or default name (PATH resolution deferred to OS / Bun.which). */
export function cursorAgentBinArg(): string {
  const fromEnv = process.env.CURSOR_AGENT_BIN?.trim();
  return fromEnv || "cursor-agent";
}

/**
 * Best-effort concrete path to cursor-agent, or undefined if not found.
 * Order: Bun.which(nameOrPath), then existsSync for an absolute/relative file path.
 */
export function resolveCursorAgentExecutable(): string | undefined {
  const arg = cursorAgentBinArg();
  const viaWhich = Bun.which(arg);
  if (viaWhich) return viaWhich;
  if (existsSync(arg)) return arg;
  return undefined;
}

/** Use for spawn/execFile: resolved path when known, else the same argv Cursor docs recommend. */
export function cursorAgentSpawnArgv0(): string {
  return resolveCursorAgentExecutable() ?? cursorAgentBinArg();
}
