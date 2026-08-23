import { execFile, type ExecFileException, type ExecFileOptionsWithStringEncoding } from "child_process";
import { providerChildEnv } from "./providers/child-env";
import type { ClaudePlanUsageLimit, ClaudePlanUsageSnapshot } from "./sdk/types";

type ExecFileCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

export type ClaudeUsageExec = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: ExecFileCallback,
) => unknown;

export function claudeUsageCommand(platform = process.platform): {
  file: string;
  args: string[];
} {
  return platform === "win32"
    ? {
        file: "cmd.exe",
        args: ["/d", "/s", "/c", "claude.cmd", "-p", "/usage", "--output-format", "json"],
      }
    : {
        file: "claude",
        args: ["-p", "/usage", "--output-format", "json"],
      };
}

function unavailable(checkedAt: number, error: string, reportText?: string): ClaudePlanUsageSnapshot {
  return {
    available: false,
    checkedAt,
    source: "claude-cli",
    limits: [],
    ...(reportText ? { reportText } : {}),
    error,
  };
}

/** Parse the human-readable report returned inside Claude Code's JSON envelope.
 * Limit labels are intentionally dynamic because Claude can add model-specific
 * windows without changing the command contract. */
export function parseClaudePlanUsageReport(
  reportText: string,
  checkedAt = Date.now(),
): ClaudePlanUsageSnapshot {
  const normalized = reportText.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return unavailable(checkedAt, "Claude Code returned an empty usage report.");

  const lines = normalized.split("\n").map((line) => line.trim());
  const limits: ClaudePlanUsageLimit[] = [];
  let firstLimitIndex = -1;

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(.+?):\s*(\d+(?:\.\d+)?)%\s+used(?:\s+(?:·|-)\s+resets\s+(.+))?$/i);
    if (!match) continue;
    if (firstLimitIndex === -1) firstLimitIndex = index;
    limits.push({
      label: match[1]!.trim(),
      usedPercent: Number(match[2]),
      ...(match[3]?.trim() ? { resetsAtText: match[3].trim() } : {}),
    });
  }

  const detailsIndex = lines.findIndex((line) => /^what['’]s contributing to your limits usage\?/i.test(line));
  const statusText = lines
    .slice(0, firstLimitIndex === -1 ? detailsIndex === -1 ? lines.length : detailsIndex : firstLimitIndex)
    .filter(Boolean)
    .join("\n") || undefined;
  const detailsText = detailsIndex === -1
    ? undefined
    : lines.slice(detailsIndex).filter(Boolean).join("\n");

  return {
    available: limits.length > 0,
    checkedAt,
    source: "claude-cli",
    ...(statusText ? { statusText } : {}),
    limits,
    ...(detailsText ? { detailsText } : {}),
    reportText: normalized,
    ...(normalized.toLowerCase().includes("last-known usage") ? { stale: true } : {}),
    ...(limits.length === 0 ? { error: "Claude Code did not report subscription plan limits." } : {}),
  };
}

export function parseClaudePlanUsageEnvelope(
  stdout: string,
  checkedAt = Date.now(),
): ClaudePlanUsageSnapshot {
  try {
    const parsed = JSON.parse(stdout.trim()) as { is_error?: unknown; result?: unknown };
    if (!parsed || typeof parsed !== "object" || parsed.is_error === true || typeof parsed.result !== "string") {
      return unavailable(checkedAt, "Claude Code returned an unexpected usage response.");
    }
    return parseClaudePlanUsageReport(parsed.result, checkedAt);
  } catch {
    return unavailable(checkedAt, "Claude Code returned an unreadable usage response.");
  }
}

/** Query Claude Code's supported `/usage` command without accessing its OAuth
 * token or creating a Windows console window. The command reports zero model
 * turns and degrades to an unavailable snapshot when the CLI cannot answer. */
export function probeClaudePlanUsage(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exec?: ClaudeUsageExec;
  timeoutMs?: number;
  now?: () => number;
} = {}): Promise<ClaudePlanUsageSnapshot> {
  const command = claudeUsageCommand(options.platform);
  const run = options.exec ?? (execFile as unknown as ClaudeUsageExec);
  const checkedAt = (options.now ?? Date.now)();

  return new Promise((resolve) => {
    run(
      command.file,
      command.args,
      {
        env: {
          ...providerChildEnv(options.env ?? process.env),
          CLAUDECODE: "",
          NO_COLOR: "1",
        },
        encoding: "utf8",
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: 512 * 1024,
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(unavailable(checkedAt, "Claude Code could not report subscription usage."));
          return;
        }
        resolve(parseClaudePlanUsageEnvelope(stdout, checkedAt));
      },
    );
  });
}
