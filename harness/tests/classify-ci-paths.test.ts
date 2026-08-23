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
});

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
});

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
});

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
});

test("workflow inputs fail toward extras", () => {
  const result = classify([
    "-EventName", "push",
    "-FromFiles",
    "-ChangedFiles", ".github/workflows/ci.yml", "harness/index.ts",
  ]);
  expect(result.ui_build).toBe("true");
  expect(result.rust).toBe("true");
  expect(result.reason.startsWith("fail-open:")).toBe(true);
});

test("empty or unreadable diffs fail toward extras", () => {
  const empty = classify(["-EventName", "push", "-FromFiles"]);
  expect(empty).toMatchObject({ ui_build: "true", rust: "true", reason: "empty-diff" });

  const newHistory = classify([
    "-EventName", "push",
    "-BeforeSha", "0000000000000000000000000000000000000000",
    "-Sha", "abc",
  ]);
  expect(newHistory).toMatchObject({ ui_build: "true", rust: "true", reason: "new-history" });
});

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
});
