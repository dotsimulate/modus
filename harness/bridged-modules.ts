/**
 * The list of harness runtime modules that built-in moves import by relative
 * path and that must therefore be bridged into dynamically-loaded moves in
 * packaged builds. Kept in a dependency-free module so both the runtime bridge
 * (harness/harness-bridge.ts) and the packaging step
 * (desktop/stage-managed-backend.ts) can read it without pulling in the whole
 * harness graph (DB connections, timers, session manager, …).
 *
 * Type-only imports (e.g. `move-types`) are erased by the transpiler and need
 * no entry here — only runtime value imports do.
 */
export const BRIDGED_HARNESS_MODULES = [
  "docs-registry",
  "modus-mcp",
  "db",
  "git",
  "mission-runner",
  "project-ui",
  "session-manager",
  "profiles",
  "profile-schemas",
  "move-runner",
] as const;

export type BridgedHarnessModule = (typeof BRIDGED_HARNESS_MODULES)[number];
