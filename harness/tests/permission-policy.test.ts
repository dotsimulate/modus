import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePermissionPolicy, pendingPermissionCount, permissionPolicyNeedsApproval } from "../permission-policy";
import { claudePermissionModeForPolicy } from "../providers/claude-code";
import { approvalModeForPolicy } from "../providers/gemini-cli";
import { mapPermissionPolicy } from "../providers/codex";
import { shouldSkipPermissions } from "../providers/opencode";
import { needsApproval as antigravityNeedsApproval } from "../providers/antigravity";
import { toolDecision as grokToolDecision } from "../providers/grok-build";

function grokContext(permissionPolicy: any) {
  return {
    opts: { permissionPolicy },
    profile: undefined,
    session: {
      _configOverrides: {},
      sessionApprovals: new Set<string>(),
    },
  } as any;
}

describe("portable permission policy", () => {
  test("normalizes legacy allow without mutating the source object", () => {
    const source = { default: "allow" as const, requireApproval: ["Bash"] };
    const result = normalizePermissionPolicy(source);
    expect(result).toEqual({
      policy: { default: "approve", requireApproval: ["Bash"] },
      normalizedLegacyAllow: true,
    });
    expect(source.default).toBe("allow");
  });

  test("normalizes legacy profile files once in memory without rewriting them", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-permission-policy-"));
    const project = join(root, "project");
    const home = join(root, "home");
    const profilePath = join(project, ".modus", "profiles", "agents", "legacy.json");
    const source = JSON.stringify({
      description: "legacy policy",
      prompt: "test",
      permissionPolicy: { default: "allow", requireApproval: ["Bash"] },
    });

    try {
      mkdirSync(join(profilePath, ".."), { recursive: true });
      writeFileSync(profilePath, source, "utf8");
      const proc = Bun.spawn([
        process.execPath,
        "run",
        join(import.meta.dir, "fixtures", "profile-permission-normalization-driver.ts"),
        project,
      ], {
        env: {
          ...process.env,
          MODUS_HOME: home,
          HARNESS_SECRETS_FILE: join(root, "secrets.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code, stderr).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.first).toEqual({ default: "approve", requireApproval: ["Bash"] });
      expect(result.second).toEqual(result.first);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("project:legacy");
      expect(readFileSync(profilePath, "utf8")).toBe(source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("absent remains the bypass compatibility default", () => {
    expect(claudePermissionModeForPolicy(undefined)).toBe(claudePermissionModeForPolicy("bypass"));
    expect(approvalModeForPolicy(undefined)).toBe(approvalModeForPolicy("bypass"));
    expect(mapPermissionPolicy(undefined)).toEqual(mapPermissionPolicy("bypass"));
    expect(shouldSkipPermissions(undefined)).toBe(true);
    expect(antigravityNeedsApproval("bypass", "run_command")).toBe(false);
    expect(grokToolDecision(grokContext(undefined), "run_terminal_cmd")).toBe("allow");
  });

  test("auto-edit maps to native containment and asks for shell in hook providers", () => {
    expect(claudePermissionModeForPolicy("auto-edit")).toBe("acceptEdits");
    expect(approvalModeForPolicy("auto-edit")).not.toBe(approvalModeForPolicy("ask"));
    expect(mapPermissionPolicy("auto-edit")).toEqual({ approvalPolicy: "never", sandboxMode: "workspace-write" });
    expect(shouldSkipPermissions("auto-edit")).toBe(false);
    expect(antigravityNeedsApproval("auto-edit", "run_command")).toBe(true);
    expect(antigravityNeedsApproval("auto-edit", "write_to_file")).toBe(false);
    expect(grokToolDecision(grokContext("auto-edit"), "run_terminal_cmd")).toBe("ask");
  });

  test("the supported object policy keeps approve semantics across all six mappings", () => {
    const policy = { default: "approve" as const, requireApproval: ["Bash"] };
    expect(permissionPolicyNeedsApproval(policy, "Bash", new Set())).toBe(true);
    expect(permissionPolicyNeedsApproval(policy, "Read", new Set())).toBe(false);
    expect(antigravityNeedsApproval(policy, "Bash")).toBe(true);
    expect(grokToolDecision(grokContext({ default: "approve", requireApproval: ["run_terminal_cmd"] }), "run_terminal_cmd")).toBe("ask");
    expect(approvalModeForPolicy(policy)).toBe(approvalModeForPolicy("auto-edit"));
    expect(mapPermissionPolicy(policy)).toEqual(mapPermissionPolicy("bypass"));
    expect(shouldSkipPermissions(policy)).toBe(true);
  });

  test("the supported object policy keeps ask semantics across all six mappings", () => {
    const policy = { default: "ask" as const };
    expect(claudePermissionModeForPolicy(policy)).toBe("default");
    expect(approvalModeForPolicy(policy)).toBe(approvalModeForPolicy("ask"));
    expect(mapPermissionPolicy(policy)).toEqual(mapPermissionPolicy("ask"));
    expect(shouldSkipPermissions(policy)).toBe(false);
    expect(antigravityNeedsApproval(policy, "write_to_file")).toBe(true);
    expect(grokToolDecision(grokContext(policy), "write_file")).toBe("ask");
  });

  test("Claude's native JSON permission mode remains compatible", () => {
    expect(claudePermissionModeForPolicy(
      { default: "approve" },
      { claude: { permissionMode: "auto" } },
    )).toBe("auto");
    expect(claudePermissionModeForPolicy(
      { default: "approve" },
      { claude: { permissionMode: "bypassPermissions" } },
    )).toBe("bypassPermissions");
  });

  test("pending counts tolerate providers emitting on either side of map mutation", () => {
    expect(pendingPermissionCount(0, "permission_request", false)).toBe(1);
    expect(pendingPermissionCount(1, "permission_request", true)).toBe(1);
    expect(pendingPermissionCount(1, "permission_resolved", true)).toBe(0);
    expect(pendingPermissionCount(0, "permission_resolved", false)).toBe(0);
  });
});
