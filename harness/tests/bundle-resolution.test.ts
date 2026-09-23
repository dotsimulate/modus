import { resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The desktop package is a bundle, and bundling resolves imports under
 * different rules than the Bun runtime does. Bun's runtime tolerates
 * `require()` of an ESM-only dependency; `Bun.build` honours the package's
 * exports conditions strictly and fails outright. So a single `require()` of a
 * `"type": "module"` dependency compiles, typechecks, passes every test and
 * runs perfectly in dev while making the installer unbuildable.
 *
 * That is exactly what happened: `model-oneshot.ts` required
 * `@earendil-works/pi-ai`, whose exports map declares only an "import"
 * condition, and the desktop build broke for a day with no other signal. CI
 * cannot catch it either — it builds the Rust crate against non-packaging
 * fixtures and never runs the real staging step.
 *
 * These are the same entrypoints `desktop/stage-managed-backend.ts` bundles.
 * Nothing is executed: Bun.build only reads and links the graph, so importing
 * index.ts here does not start a server.
 */
const ENTRYPOINTS = [
  "index.ts",
  "cli.ts",
  "svg-render-worker.ts",
];

describe("packaged bundle resolves", () => {
  for (const entry of ENTRYPOINTS) {
    test(`${entry} bundles for the desktop package`, async () => {
      const result = await Bun.build({
        entrypoints: [join(resolveTestSourceDir(import.meta.dir, ".."), entry)],
        target: "bun",
        minify: false,
        sourcemap: "none",
        // Mirrors the staging script: bun-pty is a Windows-only ConPTY binding
        // behind an IS_WINDOWS guard and has no build to resolve elsewhere.
        external: process.platform === "win32" ? [] : ["bun-pty"],
      });
      const messages = result.logs.map((log) => log.message).join("\n");
      expect(messages).not.toContain("Could not resolve");
      expect(result.success).toBe(true);
      if (entry === "index.ts" && result.success) {
        const serverBundle = await result.outputs[0]!.text();
        for (const removedRuntime of [
          "createAntigravityProvider",
          "createGeminiCliProvider",
          "@google/gemini-cli-core",
          "antigravity-mcp-bridge",
          "resolveAntigravityExecutable",
          "fetchGeminiUsageSnapshot",
          "runAntigravityCommand",
          "AGY_CLI_DISABLE_AUTO_UPDATE",
        ]) {
          expect(serverBundle).not.toContain(removedRuntime);
        }
      }
    }, 120_000);
  }
});
