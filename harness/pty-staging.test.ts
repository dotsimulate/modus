import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The packaged Windows terminal depends on a file no build step used to copy.
 *
 * Bundling inlines bun-pty's JavaScript into server.js, but the Rust library it
 * dlopens is resolved from disk when a terminal is created. Staging never
 * copied it, so an installed build had working terminals only while a manual
 * copy survived in the install directory — and a reinstall wiped it, failing
 * with "librust_pty shared library not found".
 *
 * Nothing else can catch that. It is Windows-only, runtime-only, and reached
 * solely by opening a terminal, so the build, every typecheck and the whole
 * suite stay green while the shipped app cannot spawn a shell. These two checks
 * pin the halves that drift: the path bun-pty publishes, and the staging step
 * that consumes it.
 */
const repositoryDir = join(import.meta.dir, "..");
const PTY_LIBRARY_PATH = join("rust-pty", "target", "release", "rust_pty.dll");

describe("packaged terminal staging", () => {
  test("bun-pty still ships the ConPTY library where staging looks for it", () => {
    // Not platform-gated: the published package carries every platform's
    // native build, so a version bump that moves the file fails everywhere
    // rather than only on the one OS that would notice at runtime.
    const source = join(repositoryDir, "node_modules", "bun-pty", PTY_LIBRARY_PATH);
    expect(existsSync(source)).toBe(true);
  });

  test("the staging script copies it into the package", () => {
    const script = readFileSync(join(repositoryDir, "desktop", "stage-managed-backend.ts"), "utf8");
    // Both directions: the path constant must name the file bun-pty publishes,
    // and stage() must actually invoke the step. Deleting either fails here.
    expect(script).toContain(`join("rust-pty", "target", "release", "rust_pty.dll")`);
    expect(script).toContain("stagePtyLibrary();");
  });
});
