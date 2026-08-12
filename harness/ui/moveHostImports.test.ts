import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bindHostImports, redirectHostModules } from "./src/move-host-imports";

function shim(source: string): string {
  return bindHostImports(redirectHostModules(source));
}

/** The rewritten module must be syntactically valid, which is the whole point. */
function parses(source: string): boolean {
  // Strip ESM syntax the Function constructor cannot host; imports are gone by
  // now. The export-list form must go before the bare `export ` prefix strip,
  // or `export { a as default };` degrades into an invalid block statement.
  const stripped = source
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, "")
    .replace(/^export\s+default\s+/gm, "const __default__ = ")
    .replace(/^export\s+/gm, "");
  try {
    new Function(stripped);
    return true;
  } catch {
    return false;
  }
}

describe("host import rebinding", () => {
  test("renames aliased named imports with ':' rather than 'as'", () => {
    const out = shim('import { useEffect as useEffect2, useState as useState2 } from "react";');
    expect(out).toBe("const { useEffect: useEffect2, useState: useState2 } = __MODUS_REACT__;");
    expect(parses(out)).toBe(true);
  });

  test("leaves unaliased named imports alone", () => {
    expect(shim('import { useMemo, useRef } from "react";'))
      .toBe("const { useMemo, useRef } = __MODUS_REACT__;");
  });

  test("handles namespace, default, and default-plus-named forms", () => {
    expect(shim('import * as React from "react";')).toBe("const React = __MODUS_REACT__;");
    expect(shim('import React from "react";')).toBe("const React = __MODUS_REACT__;");
    expect(shim('import React, { useState as s } from "react";'))
      .toBe("const React = __MODUS_REACT__; const { useState: s } = __MODUS_REACT__;");
  });

  test("rebinds both jsx runtimes", () => {
    expect(shim('import { jsx as jsx2, jsxs } from "react/jsx-runtime";'))
      .toBe("const { jsx: jsx2, jsxs } = __MODUS_JSX_RUNTIME__;");
    expect(shim('import { jsxDEV as d } from "react/jsx-dev-runtime";'))
      .toBe("const { jsxDEV: d } = __MODUS_JSX_DEV_RUNTIME__;");
  });

  // The alias form only appears once two modules in the tree import React —
  // i.e. the first time a move reuses a shared core component. Building it for
  // real is the only way this stays honest as the bundler changes.
  test("a move component that reuses a second React module still rewrites to valid JS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "modus-host-imports-"));
    try {
      writeFileSync(join(dir, "shared.tsx"), `
        import { useEffect, useMemo, useRef, useState } from "react";
        export function Shared({ html }: { html: string }) {
          const v = useMemo(() => html, [html]);
          const r = useRef<null>(null);
          const [h, setH] = useState(0);
          useEffect(() => setH(1), []);
          return <div ref={r} data-h={h}>{v}</div>;
        }
      `);
      writeFileSync(join(dir, "view.tsx"), `
        import { useEffect, useState } from "react";
        import { Shared } from "./shared";
        export default function View() {
          const [n, setN] = useState(0);
          useEffect(() => setN(1), []);
          return <Shared html={String(n)} />;
        }
      `);

      const built = await Bun.build({
        entrypoints: [join(dir, "view.tsx")],
        format: "esm",
        target: "browser",
        external: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
        define: { "process.env.NODE_ENV": '"production"' },
      });
      expect(built.success).toBe(true);

      const js = await built.outputs[0]!.text();
      // Guard the premise: if the bundler stops aliasing, this test stops testing.
      expect(/\bas\s+\w+\s*[,}]/.test(js)).toBe(true);

      const rewritten = shim(js);
      expect(rewritten).not.toContain("import {");
      expect(/const\s*\{[^}]*\bas\b/.test(rewritten)).toBe(false);
      expect(parses(rewritten)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
