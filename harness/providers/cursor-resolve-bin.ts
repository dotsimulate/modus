/**
 * Resolve cursor-agent executable for health checks, model listing, and spawn.
 * Windows: prefer CURSOR_AGENT_BIN (full path) when the installer did not update PATH for your harness process.
 */

import { existsSync } from "fs";
import { resolveCli } from "./resolve-cli";

/** Raw argv[0] from env or default name (PATH resolution deferred to OS / Bun.which). */
export function cursorAgentBinArg(): string {
  const fromEnv = process.env.CURSOR_AGENT_BIN?.trim();
  return fromEnv || "cursor-agent";
}

/**
 * Best-effort concrete path to cursor-agent, or undefined if not found.
 * Order: PATH + user install dirs (resolveCli), then existsSync for an
 * absolute/relative file path.
 */
export function resolveCursorAgentExecutable(): string | undefined {
  const arg = cursorAgentBinArg();
  const resolved = resolveCli(arg);
  if (resolved) return resolved;
  if (existsSync(arg)) return arg;
  return undefined;
}

/** Use for spawn/execFile: resolved path when known, else the same argv Cursor docs recommend. */
export function cursorAgentSpawnArgv0(): string {
  return resolveCursorAgentExecutable() ?? cursorAgentBinArg();
}
