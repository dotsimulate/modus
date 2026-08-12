/**
 * Rebinding of a bundled move component's host imports.
 *
 * A move's React is externalized at build time and re-bound to the host's React
 * instance at load time, because two React copies in one tree break hooks. The
 * rebinding is a source rewrite, and it lives here — outside
 * move-component-loader.ts — so it can be unit-tested without pulling React,
 * the DOM, and the API client into the test, the same reason move-api-result.ts
 * sits outside modus-mcp.ts.
 */

/** The host globals a bundled move component's imports are rebound onto. */
const HOST_BINDINGS = ["__MODUS_REACT__", "__MODUS_JSX_RUNTIME__", "__MODUS_JSX_DEV_RUNTIME__"] as const;

/**
 * Turn an ESM named-import list into a destructuring pattern.
 *
 * ESM renames with `as`, object destructuring renames with `:`, and the two are
 * not interchangeable — `const { useState as useState2 }` is a syntax error.
 * The bundler only emits aliases once two modules in the component tree import
 * React, which is precisely what happens the first time a move reuses a shared
 * component. So the naive rewrite worked right up until modularity was used,
 * and then failed as an unreadable "component failed to load".
 */
function destructurePattern(specifiers: string): string {
  return specifiers
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^(\S+)\s+as\s+(\S+)$/, "$1: $2"))
    .join(", ");
}

/**
 * Rewrite imports of host-provided globals into local const bindings.
 *
 * Order matters: the default-plus-named form must be consumed before the bare
 * default form, or `import React, { useState } from "x"` is left half-rewritten.
 */
export function bindHostImports(source: string): string {
  let out = source;
  for (const binding of HOST_BINDINGS) {
    out = out
      .replace(
        new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${binding}["'];?`, "g"),
        (_match, specifiers: string) => `const { ${destructurePattern(specifiers)} } = ${binding};`,
      )
      .replace(
        new RegExp(`import\\s*\\*\\s*as\\s+(\\w+)\\s*from\\s*["']${binding}["'];?`, "g"),
        (_match, local: string) => `const ${local} = ${binding};`,
      )
      .replace(
        new RegExp(`import\\s+(\\w+)\\s*,\\s*\\{([^}]*)\\}\\s*from\\s*["']${binding}["'];?`, "g"),
        (_match, local: string, specifiers: string) =>
          `const ${local} = ${binding}; const { ${destructurePattern(specifiers)} } = ${binding};`,
      )
      .replace(
        new RegExp(`import\\s+(\\w+)\\s*from\\s*["']${binding}["'];?`, "g"),
        (_match, local: string) => `const ${local} = ${binding};`,
      );
  }
  return out;
}

/** Rewrite bare module specifiers to the host-global placeholders. */
export function redirectHostModules(source: string): string {
  return source
    .replace(/from\s*["']react\/jsx-dev-runtime["']/g, 'from "__MODUS_JSX_DEV_RUNTIME__"')
    .replace(/from\s*["']react\/jsx-runtime["']/g, 'from "__MODUS_JSX_RUNTIME__"')
    .replace(/from\s*["']react["']/g, 'from "__MODUS_REACT__"')
    .replace(/from\s*["']react-dom["']/g, 'from "__MODUS_REACT__"');
}
