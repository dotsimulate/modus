/**
 * Harness runtime bridge for dynamically-loaded move modules.
 *
 * Built-in moves (`harness/moves/<name>/context.ts`) import harness runtime
 * modules by relative path — e.g. `modus-brain` imports `../../docs-registry`,
 * `api-access` imports `../../modus-mcp`, `project-call` imports
 * `../../session-manager`. In a *dev* run the backend is unbundled, so a move
 * loaded via dynamic `import()` resolves those specifiers to the very same
 * on-disk modules the server already imported — one shared instance of the DB
 * connection, the MCP token store, the session manager, and so on.
 *
 * In a *packaged* build the backend is bundled into a single `server.js` and
 * the harness `.ts` sources are not shipped, so those relative imports have
 * nothing to resolve against. Packaging therefore emits a tiny CJS shim per
 * bridged module (see `desktop/stage-managed-backend.ts`) that re-exports the
 * live instance registered here on a process global. That keeps a move's
 * singletons identical to `server.js`'s — bundling a *copy* into each move
 * would silently give it a second DB/token store and break state.
 *
 * The registry lives on `globalThis` so it is shared across the bundle boundary
 * between `server.js` and a dynamically-imported shim.
 */

import * as appPaths from "./app-paths";
import * as docsRegistry from "./docs-registry";
import * as modusMcp from "./modus-mcp";
import * as db from "./db";
import * as git from "./git";
import * as missionRunner from "./mission-runner";
import * as projectUi from "./project-ui";
import * as sessionManager from "./session-manager";
import * as profiles from "./profiles";
import * as profileSchemas from "./profile-schemas";
import * as moveRunner from "./move-runner";
import * as sessionProjects from "./session-projects";
import { BRIDGED_HARNESS_MODULES } from "./bridged-modules";

export { BRIDGED_HARNESS_MODULES } from "./bridged-modules";

const GLOBAL_KEY = "__modusHarness__";

function registry(): Map<string, unknown> {
  const g = globalThis as unknown as Record<string, Map<string, unknown> | undefined>;
  let reg = g[GLOBAL_KEY];
  if (!reg) {
    reg = new Map<string, unknown>();
    g[GLOBAL_KEY] = reg;
  }
  return reg;
}

/**
 * Publish the live harness module namespaces onto the process global so
 * packaged move shims can resolve them. Idempotent; call once at server
 * startup, before any move can be loaded.
 */
export function initHarnessBridge(): void {
  const reg = registry();
  const namespaces: Record<(typeof BRIDGED_HARNESS_MODULES)[number], unknown> = {
    "app-paths": appPaths,
    "docs-registry": docsRegistry,
    "modus-mcp": modusMcp,
    "db": db,
    "git": git,
    "mission-runner": missionRunner,
    "project-ui": projectUi,
    "session-manager": sessionManager,
    "profiles": profiles,
    "profile-schemas": profileSchemas,
    "move-runner": moveRunner,
    "session-projects": sessionProjects,
  };
  for (const name of BRIDGED_HARNESS_MODULES) {
    if (!reg.has(name)) reg.set(name, namespaces[name]);
  }
}
