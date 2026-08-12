import type { MoveConfig } from "./move-types";

/**
 * Resolve a browser component from declarations owned by the move.
 *
 * The request may select one of those declared filenames, but it can never
 * name an arbitrary file. Keeping this check outside the route makes the
 * request-to-filesystem boundary directly testable without importing index.ts.
 */
export function resolveDeclaredMoveComponent(
  move: MoveConfig,
  requestedComponent?: string | null,
): string | null {
  if (!requestedComponent) return move.widget?.component ?? null;

  const declared = [move.widget?.component, move.toolView?.component]
    .filter((component): component is string => typeof component === "string");
  return declared.includes(requestedComponent) ? requestedComponent : null;
}
