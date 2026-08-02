import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { providerChildEnv } from "./child-env";
import { resolveCli } from "./resolve-cli";

export type AntigravityCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type Which = (command: string) => string | null;

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

/** Resolve the `agy` CLI only. The Antigravity desktop launcher is not CLI-compatible. */
export function resolveAntigravityExecutable(options: {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  home?: string;
  which?: Which;
} = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const which = options.which ?? ((command) => resolveCli(command));
  const override = env.ANTIGRAVITY_CLI_PATH?.trim();
  if (override && existsSync(override)) return override;

  const fromPath = which("agy") ?? (platform === "win32" ? which("agy.exe") : null);
  if (fromPath) return fromPath;

  const candidates = platform === "win32"
    ? [
        env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "agy", "bin", "agy.exe") : "",
        join(home, "AppData", "Local", "agy", "bin", "agy.exe"),
      ]
    : [join(home, ".local", "bin", "agy")];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

export function parseAntigravityModels(output: string): Array<{ id: string; owned_by: "google" }> {
  const models: Array<{ id: string; owned_by: "google" }> = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim();
    if (!line || /^(available models|models):?$/i.test(line)) continue;
    if (/^error:/i.test(line) || /please sign in/i.test(line)) continue;
    const withoutMarker = line.replace(/^[*\-\u2022\u2713\u2714\s]+/, "").trim();
    const id = withoutMarker
      .split(/\s{2,}|\s+-\s+/, 1)[0]
      ?.replace(/\s+\((?:current|default|selected)\)$/i, "")
      .trim();
    if (!id || id.length > 120 || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, owned_by: "google" });
  }
  return models;
}

export function antigravityAuthFromModelsResult(result: AntigravityCommandResult): {
  authenticated: boolean;
  detail: string;
} {
  const combined = stripAnsi(`${result.stdout}\n${result.stderr}`).trim();
  if (result.timedOut) return { authenticated: false, detail: "model probe timed out" };
  if (/please sign in|not signed in|authentication required|unauthenticated/i.test(combined)) {
    return { authenticated: false, detail: "run `agy` once to sign in" };
  }
  if (result.exitCode !== 0) {
    return { authenticated: false, detail: combined.slice(0, 180) || `agy models exited ${result.exitCode}` };
  }
  return parseAntigravityModels(result.stdout).length > 0
    ? { authenticated: true, detail: "authenticated" }
    : { authenticated: false, detail: "agy did not return an authenticated model list" };
}

export async function runAntigravityCommand(
  executable: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<AntigravityCommandResult> {
  const proc = Bun.spawn({
    cmd: [executable, ...args],
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...providerChildEnv(),
      ...(options.env ?? {}),
      AGY_CLI_DISABLE_AUTO_UPDATE: options.env?.AGY_CLI_DISABLE_AUTO_UPDATE ?? "true",
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* best effort */ }
  }, options.timeoutMs ?? 15_000);
  try {
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timeout);
  }
}
