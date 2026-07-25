import { execFile, type ExecFileException, type ExecFileOptionsWithStringEncoding } from "child_process";

type ClaudeAccount = Record<string, unknown>;

type ExecFileCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

export type ClaudeAccountExec = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: ExecFileCallback,
) => unknown;

export function claudeAccountCommand(platform = process.platform): {
  file: string;
  args: string[];
} {
  return platform === "win32"
    ? {
        file: "cmd.exe",
        args: ["/d", "/s", "/c", "claude.cmd", "auth", "status", "--json"],
      }
    : {
        file: "claude",
        args: ["auth", "status", "--json"],
      };
}

/** Probe the optional Claude account status without ever creating a Windows
 * console window. Invalid, unavailable, or slow CLIs degrade to no account. */
export function probeClaudeAccount(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exec?: ClaudeAccountExec;
  timeoutMs?: number;
} = {}): Promise<ClaudeAccount | null> {
  const command = claudeAccountCommand(options.platform);
  const run = options.exec ?? (execFile as unknown as ClaudeAccountExec);

  return new Promise((resolve) => {
    run(
      command.file,
      command.args,
      {
        env: { ...(options.env ?? process.env), CLAUDECODE: "" },
        encoding: "utf8",
        timeout: options.timeoutMs ?? 10_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}
