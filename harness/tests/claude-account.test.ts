import { describe, expect, test } from "bun:test";
import {
  claudeAccountCommand,
  probeClaudeAccount,
  type ClaudeAccountExec,
} from "../claude-account";

describe("Claude account probe", () => {
  test("uses an explicit hidden cmd shim on Windows", async () => {
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: Parameters<ClaudeAccountExec>[2];
    }> = [];
    const exec: ClaudeAccountExec = (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, '{"authenticated":true}', "");
      return {};
    };

    await expect(probeClaudeAccount({
      platform: "win32",
      env: { PATH: "test-path", CLAUDECODE: "nested" },
      exec,
    })).resolves.toEqual({ authenticated: true });

    expect(claudeAccountCommand("win32")).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", "claude.cmd", "auth", "status", "--json"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toMatchObject({
      windowsHide: true,
      shell: false,
      encoding: "utf8",
    });
    expect((calls[0]?.options.env as NodeJS.ProcessEnv).CLAUDECODE).toBe("");
  });

  test("degrades invalid or unavailable account output to null", async () => {
    const invalid: ClaudeAccountExec = (_file, _args, _options, callback) => {
      callback(null, "not-json", "");
      return {};
    };
    const unavailable: ClaudeAccountExec = (_file, _args, _options, callback) => {
      callback(Object.assign(new Error("missing"), { code: "ENOENT" }), "", "");
      return {};
    };

    await expect(probeClaudeAccount({ exec: invalid })).resolves.toBeNull();
    await expect(probeClaudeAccount({ exec: unavailable })).resolves.toBeNull();
  });
});
