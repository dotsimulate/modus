import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolveTestSourceDir } from "node:path";
import { join, resolve } from "path";

const repoRoot = resolve(resolveTestSourceDir(import.meta.dir, ".."), "..");
const script = resolve(repoRoot, ".github/scripts/classify-ci-paths.ps1");

function classify(
  args: string[],
  cwd = repoRoot,
): { ui_build: string; rust: string; reason: string } {
  const shell = process.platform === "win32" ? "powershell" : "pwsh";
  const result = Bun.spawnSync([
    shell,
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    ...args,
  ], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  expect(result.exitCode, stderr || stdout).toBe(0);
  const jsonLine = stdout.split(/\r?\n/).filter(Boolean).at(-1);
  expect(jsonLine).toBeTruthy();
  return JSON.parse(jsonLine!);
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  expect(result.exitCode, stderr || stdout).toBe(0);
  return stdout;
}

test("non-push events run extras", () => {
  const pullRequest = classify(["-EventName", "pull_request"]);
  expect(pullRequest).toMatchObject({ ui_build: "true", rust: "true" });
  expect(pullRequest.reason).toBe("event:pull_request");

  const dispatch = classify(["-EventName", "workflow_dispatch"]);
  expect(dispatch).toMatchObject({ ui_build: "true", rust: "true" });
  expect(dispatch.reason).toBe("event:workflow_dispatch");
}, 30_000);

test("harness-only changes skip extras", () => {
  const result = classify([
    "-EventName", "push",
    "-FromFiles",
    "-ChangedFiles", "harness/index.ts", "CONTRIBUTING.md",
  ]);
  expect(result).toEqual({
    ui_build: "false",
    rust: "false",
    reason: "core-only",
  });
}, 30_000);

test("UI tree and SDK imports request a production UI build", () => {
  const ui = classify([
    "-EventName", "push",
    "-FromFiles",
    "-ChangedFiles", "harness/ui/src/App.tsx",
  ]);
  expect(ui).toEqual({ ui_build: "true", rust: "false", reason: "ui" });

  const sdk = classify([
    "-EventName", "push",
    "-FromFiles",
    "-ChangedFiles", "harness/sdk/index.ts",
  ]);
  expect(sdk).toEqual({ ui_build: "true", rust: "false", reason: "ui" });
}, 30_000);

test("desktop and cli-launcher changes request Rust verification", () => {
  const tauri = classify([
    "-EventName", "push",
    "-FromFiles",
    "-ChangedFiles", "desktop/src-tauri/src/main.rs",
  ]);
  expect(tauri).toEqual({ ui_build: "false", rust: "true", reason: "rust" });

  const launcher = classify([
    "-EventName", "push",
    "-FromFiles",
    "-ChangedFiles", "desktop/cli-launcher/src/main.rs",
  ]);
  expect(launcher).toEqual({ ui_build: "false", rust: "true", reason: "rust" });
}, 30_000);

test("notices inputs request Rust verification, which owns the crate half", () => {
  // The Rust job runs `notices:check rust`; crate license text exists only in
  // the registry that job populates. If these did not route here, a change to
  // the generator would skip the one check that verifies it.
  for (const path of [
    "harness/scripts/generate-notices.ts",
    "harness/notices/overrides.json",
    "THIRD-PARTY-NOTICES.md",
    "sbom.cdx.json",
  ]) {
    const result = classify([
      "-EventName", "push",
      "-FromFiles",
      "-ChangedFiles", path,
    ]);
    expect({ path, rust: result.rust }).toEqual({ path, rust: "true" });
  }
}, 30_000);

test("workflow inputs fail toward extras", () => {
  const result = classify([
    "-EventName", "push",
    "-FromFiles",
    "-ChangedFiles", ".github/workflows/ci.yml", "harness/index.ts",
  ]);
  expect(result.ui_build).toBe("true");
  expect(result.rust).toBe("true");
  expect(result.reason.startsWith("fail-open:")).toBe(true);
}, 30_000);

test("empty or unreadable diffs fail toward extras", () => {
  const empty = classify(["-EventName", "push", "-FromFiles"]);
  expect(empty).toMatchObject({ ui_build: "true", rust: "true", reason: "empty-diff" });

  const newHistory = classify([
    "-EventName", "push",
    "-BeforeSha", "0000000000000000000000000000000000000000",
    "-Sha", "abc",
  ]);
  expect(newHistory).toMatchObject({ ui_build: "true", rust: "true", reason: "new-history" });
}, 30_000);

test("git revision diffs classify the changed paths instead of treating SHAs as pathspecs", () => {
  const fixture = mkdtempSync(join(tmpdir(), "modus-ci-classifier-"));
  try {
    git(fixture, "init");
    git(fixture, "config", "user.name", "Modus CI Test");
    git(fixture, "config", "user.email", "modus-ci@example.invalid");
    mkdirSync(join(fixture, "harness"), { recursive: true });
    writeFileSync(join(fixture, "harness", "index.ts"), "export const version = 1;\n");
    git(fixture, "add", "harness/index.ts");
    git(fixture, "commit", "-m", "base");
    const before = git(fixture, "rev-parse", "HEAD");

    writeFileSync(join(fixture, "harness", "index.ts"), "export const version = 2;\n");
    git(fixture, "add", "harness/index.ts");
    git(fixture, "commit", "-m", "change harness only");
    const sha = git(fixture, "rev-parse", "HEAD");

    expect(classify([
      "-EventName", "push",
      "-BeforeSha", before,
      "-Sha", sha,
    ], fixture)).toEqual({
      ui_build: "false",
      rust: "false",
      reason: "core-only",
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);
