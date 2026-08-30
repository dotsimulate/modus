/**
 * Per-Vault enabled-state for the built-in (`origin: "harness"`) actions that
 * ship with the core tier.
 *
 * Built-in actions are read out of the packaged resources directory, which is
 * the installed application: Tauri's `resource_dir()`. Persisting a toggle by
 * rewriting the shipped `action.json` there is wrong twice over — on macOS that
 * path is inside the signed `.app`, and everywhere else an upgrade replaces the
 * file and silently reverts the user's choice. It is also install-wide, so two
 * Vaults could not disagree about whether an action runs.
 *
 * So the shipped `action.json` is the immutable default and this file is the
 * per-Vault overlay on top of it. Only the fields a user can actually change
 * from the UI live here; everything else stays authored.
 *
 * Shipped defaults are opt-in (`enabled: false`), so an absent overlay means
 * nothing new starts running for an existing Vault on upgrade.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { APP_PATHS } from "./app-paths";

export type CoreActionOverlayEntry = {
  enabled?: boolean;
  /** Interval override for an `interval`-triggered core action. */
  every?: string;
};

export type CoreActionOverlay = Record<string, CoreActionOverlayEntry>;

type CoreActionOverlayFile = {
  actions?: CoreActionOverlay;
};

export function coreActionOverlayPath(modusHome = APP_PATHS.modusHome): string {
  return join(modusHome, "core-actions.json");
}

/** Never throws: a corrupt overlay must not stop the harness from loading actions. */
export function readCoreActionOverlay(modusHome = APP_PATHS.modusHome): CoreActionOverlay {
  const path = coreActionOverlayPath(modusHome);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CoreActionOverlayFile;
    const actions = parsed?.actions;
    if (!actions || typeof actions !== "object" || Array.isArray(actions)) return {};
    return actions;
  } catch (err) {
    console.error(`[actions] Ignoring unreadable core action overlay at ${path}:`, err);
    return {};
  }
}

export function patchCoreActionOverlay(
  name: string,
  patch: CoreActionOverlayEntry,
  modusHome = APP_PATHS.modusHome,
): void {
  const path = coreActionOverlayPath(modusHome);
  const actions = readCoreActionOverlay(modusHome);
  actions[name] = { ...actions[name], ...patch };
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ actions }, null, 2) + "\n", "utf-8");
}
