import { describe, expect, test } from "bun:test";
import {
  claudeUsageCommand,
  parseClaudePlanUsageEnvelope,
  parseClaudePlanUsageReport,
  probeClaudePlanUsage,
  type ClaudeUsageExec,
} from "../claude-usage";

const REPORT = `You are currently using your subscription to power your Claude Code usage

Current session: 12% used · resets Aug 23, 3am (America/New_York)
Current week (all models): 36% used · resets Aug 26, 6pm (America/New_York)
Current week (Example model): 39.5% used · resets Aug 26, 6pm (America/New_York)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine.`;

describe("Claude plan usage probe", () => {
  test("parses dynamic subscription limits and explanatory details", () => {
    expect(parseClaudePlanUsageReport(REPORT, 1234)).toEqual({
      available: true,
      checkedAt: 1234,
      source: "claude-cli",
      statusText: "You are currently using your subscription to power your Claude Code usage",
      limits: [
        {
          label: "Current session",
          usedPercent: 12,
          resetsAtText: "Aug 23, 3am (America/New_York)",
        },
        {
          label: "Current week (all models)",
          usedPercent: 36,
          resetsAtText: "Aug 26, 6pm (America/New_York)",
        },
        {
          label: "Current week (Example model)",
          usedPercent: 39.5,
          resetsAtText: "Aug 26, 6pm (America/New_York)",
        },
      ],
      detailsText: "What's contributing to your limits usage?\nApproximate, based on local sessions on this machine.",
      reportText: REPORT,
    });
  });

  test("marks last-known reports stale and keeps a readable fallback", () => {
    const result = parseClaudePlanUsageReport("Showing last-known usage\nNo limits available", 42);
    expect(result).toMatchObject({
      available: false,
      checkedAt: 42,
      stale: true,
      reportText: "Showing last-known usage\nNo limits available",
      error: "Claude Code did not report subscription plan limits.",
    });
  });

  test("rejects malformed and error envelopes", () => {
    expect(parseClaudePlanUsageEnvelope("not-json", 10)).toMatchObject({
      available: false,
      checkedAt: 10,
      limits: [],
      error: "Claude Code returned an unreadable usage response.",
    });
    expect(parseClaudePlanUsageEnvelope('{"is_error":true,"result":"failed"}', 11)).toMatchObject({
      available: false,
      checkedAt: 11,
      limits: [],
      error: "Claude Code returned an unexpected usage response.",
    });
  });

  test("uses the hidden CLI shim and strips inherited Modus credentials", async () => {
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: Parameters<ClaudeUsageExec>[2];
    }> = [];
    const exec: ClaudeUsageExec = (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, JSON.stringify({ is_error: false, result: REPORT }), "");
      return {};
    };

    await expect(probeClaudePlanUsage({
      platform: "win32",
      env: {
        PATH: "test-path",
        ANTHROPIC_API_KEY: "provider-key",
        HARNESS_TOKEN: "modus-secret",
        CLAUDECODE: "nested",
      },
      exec,
      now: () => 99,
    })).resolves.toMatchObject({ available: true, checkedAt: 99 });

    expect(claudeUsageCommand("win32")).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", "claude.cmd", "-p", "/usage", "--output-format", "json"],
    });
    expect(claudeUsageCommand("linux")).toEqual({
      file: "claude",
      args: ["-p", "/usage", "--output-format", "json"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toMatchObject({
      windowsHide: true,
      shell: false,
      encoding: "utf8",
      timeout: 15_000,
    });
    const env = calls[0]?.options.env as NodeJS.ProcessEnv;
    expect(env.HARNESS_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("provider-key");
    expect(env.CLAUDECODE).toBe("");
    expect(env.NO_COLOR).toBe("1");
  });

  test("degrades unavailable CLI output without leaking stderr", async () => {
    const exec: ClaudeUsageExec = (_file, _args, _options, callback) => {
      callback(Object.assign(new Error("missing"), { code: "ENOENT" }), "", "private stderr");
      return {};
    };

    await expect(probeClaudePlanUsage({ exec, now: () => 5 })).resolves.toEqual({
      available: false,
      checkedAt: 5,
      source: "claude-cli",
      limits: [],
      error: "Claude Code could not report subscription usage.",
    });
  });
});
