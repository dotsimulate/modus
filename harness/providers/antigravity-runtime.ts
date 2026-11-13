import { existsSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { GrokAcpClient } from "./grok-build-acp";
import { providerChildEnv } from "./child-env";
import { resolveCli } from "./resolve-cli";

/**
 * Antigravity runs through Google's own `agy acp` server. That binary owns the
 * Google sign-in and bills the user's AI Pro / Ultra plan; Modus never reads or
 * forwards its credentials. Everything here is the public CLI surface.
 */

export type AntigravityCommand = { executable: string; prefixArgs: string[] };

type Which = (command: string) => string | null;

/** Resolve the `agy` CLI only. The Antigravity desktop launcher does not serve ACP. */
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

export function resolveAntigravityCommand(): AntigravityCommand | null {
  const executable = resolveAntigravityExecutable();
  return executable ? { executable, prefixArgs: [] } : null;
}

/**
 * Inherited Google API credentials are removed so a stray key in the backend's
 * environment cannot move billing from the signed-in plan to pay-as-you-go API
 * usage. A key set deliberately in the profile `env` is layered back on top.
 */
export const ANTIGRAVITY_STRIPPED_ENV = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const;

export function antigravityEnvironment(
  extra?: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = providerChildEnv(base);
  const stripped = new Set<string>(ANTIGRAVITY_STRIPPED_ENV);
  for (const key of Object.keys(env)) {
    if (stripped.has(process.platform === "win32" ? key.toUpperCase() : key)) delete env[key];
  }
  return {
    ...env,
    // A self-update mid-session replaces the binary under a live ACP server.
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    ...extra,
  };
}

export const ANTIGRAVITY_INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "Modus", version: "1" },
};

/** One ACP model entry as `session/new` reports it, e.g. `gemini-4-hydrogen-medium`. */
export type AntigravityModelEntry = { modelId: string; name?: string };

export type AntigravityModelInfo = { id: string; owned_by: "google"; contextSource: "provider-default" };

/**
 * Base model ids for the picker. ACP lists one entry per thinking level
 * (`gemini-4-hydrogen-high`), but its `model` config option carries the base
 * names (`gemini-4-hydrogen`); thinking level is Modus's separate effort control.
 */
export function antigravityBaseModels(sessionResult: any): AntigravityModelInfo[] {
  const option = Array.isArray(sessionResult?.configOptions)
    ? sessionResult.configOptions.find((entry: any) => entry?.id === "model" || entry?.category === "model")
    : undefined;
  const fromOption = Array.isArray(option?.options)
    ? option.options.map((entry: any) => entry?.value)
    : [];
  const ids: string[] = fromOption.length
    ? fromOption
    : (sessionResult?.models?.availableModels ?? []).map((entry: any) => entry?.modelId);
  const seen = new Set<string>();
  const models: AntigravityModelInfo[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, owned_by: "google", contextSource: "provider-default" });
  }
  return models;
}

const THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;

function thinkingLevelFor(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  if (effort === "off") return "low";
  if (effort === "max") return "xhigh";
  return (THINKING_LEVELS as readonly string[]).includes(effort) ? effort : undefined;
}

/**
 * Pick the concrete ACP model id for a base model plus a Modus effort level.
 *
 * An exact id (including one that already carries a level) wins. Otherwise the
 * requested level is used when that model offers it, stepping `xhigh` down to
 * `high` for models without an Extra tier, then the model's medium variant, then
 * whichever variant it lists first. Returns undefined when the model is unknown
 * so the caller can report it instead of silently running a different model.
 */
export function resolveAntigravityModelId(
  available: readonly AntigravityModelEntry[],
  model: string | undefined,
  effort: string | undefined,
): string | undefined {
  const ids = available.map((entry) => entry.modelId);
  const level = thinkingLevelFor(effort);
  if (!model) {
    return undefined;
  }
  if (ids.includes(model) && !level) return model;
  const base = THINKING_LEVELS.reduce(
    (current, suffix) => current.endsWith(`-${suffix}`) ? current.slice(0, -(suffix.length + 1)) : current,
    model,
  );
  const variants = ids.filter((id) => id.startsWith(`${base}-`)
    && (THINKING_LEVELS as readonly string[]).includes(id.slice(base.length + 1)));
  if (!variants.length) return ids.includes(model) ? model : undefined;
  const wanted = level ? [level, ...(level === "xhigh" ? ["high"] : [])] : [];
  if (!level && model !== base) wanted.push(model.slice(base.length + 1));
  for (const suffix of [...wanted, "medium"]) {
    if (variants.includes(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }
  return variants[0];
}

/**
 * Antigravity's ACP reply when Google has not verified a new account (403
 * VALIDATION_REQUIRED). It arrives as ordinary agent text with
 * `stopReason: end_turn`, so it has to be recognized by content.
 */
export function isAntigravityVerificationNotice(text: string): boolean {
  return /^\W*Verification Required\W*$/i.test(text.trim());
}

export const ANTIGRAVITY_VERIFICATION_MESSAGE =
  "Google has not verified this Antigravity account yet. Run `agy` in a terminal, sign in, "
  + "and finish the account verification Google asks for, then retry.";

export type AntigravityProbe = {
  authenticated: boolean;
  detail: string;
  models: AntigravityModelInfo[];
  tier?: string;
};

const PROBE_TTL_MS = 60_000;
let probeCache: { at: number; key: string; promise: Promise<AntigravityProbe> } | null = null;

/**
 * Open a throwaway ACP session to read sign-in state, plan tier, and models.
 * ACP reports models only from `session/new`, so one probe answers both the
 * health check and the model picker; it is shared for a minute so the two do
 * not each spawn `agy`.
 */
export function probeAntigravity(command = resolveAntigravityCommand()): Promise<AntigravityProbe> {
  if (!command) {
    return Promise.resolve({ authenticated: false, detail: "agy not in PATH", models: [] });
  }
  const key = `${command.executable}\0${command.prefixArgs.join("\0")}`;
  if (probeCache && probeCache.key === key && Date.now() - probeCache.at < PROBE_TTL_MS) {
    return probeCache.promise;
  }
  const promise = runProbe(command);
  probeCache = { at: Date.now(), key, promise };
  promise.catch(() => { if (probeCache?.promise === promise) probeCache = null; });
  return promise;
}

export function resetAntigravityProbeCacheForTests(): void {
  probeCache = null;
}

async function runProbe(command: AntigravityCommand): Promise<AntigravityProbe> {
  const client = new GrokAcpClient({
    executable: command.executable,
    args: [...command.prefixArgs, "acp"],
    cwd: tmpdir(),
    env: antigravityEnvironment(),
    requestTimeoutMs: 30_000,
    label: "Antigravity ACP",
  });
  try {
    client.start();
    await client.request("initialize", ANTIGRAVITY_INITIALIZE_PARAMS, 30_000);
    const created = await client.request("session/new", { cwd: tmpdir(), mcpServers: [] }, 30_000);
    const tier = typeof created?._meta?.antigravity?.tier?.name === "string"
      ? created._meta.antigravity.tier.name
      : undefined;
    if (typeof created?.sessionId === "string") {
      try { await client.request("session/close", { sessionId: created.sessionId }, 10_000); } catch {}
    }
    return {
      authenticated: true,
      detail: tier ? `signed in (${tier})` : "signed in",
      models: antigravityBaseModels(created),
      ...(tier ? { tier } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      authenticated: false,
      detail: /auth|sign.?in|login|credential/i.test(message)
        ? "run `agy` once in a terminal to sign in with Google"
        : message.slice(0, 200),
      models: [],
    };
  } finally {
    await client.close();
  }
}

export type AntigravityCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export async function runAntigravityCommand(
  executable: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<AntigravityCommandResult> {
  const proc = Bun.spawn({
    cmd: [executable, ...args],
    cwd: options.cwd ?? tmpdir(),
    env: antigravityEnvironment(),
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

/**
 * Name of the agy plugin the retired print-mode adapter installed globally. Its
 * hooks point at scripts this build no longer ships (and on Windows its quoted
 * hook command never ran at all), so while enabled it fails every agy tool call
 * — in Modus and in the user's own terminal alike.
 */
export const LEGACY_MODUS_AGY_PLUGIN = "modus-provider";

/** True when `agy plugin list --json` output shows the legacy plugin enabled. */
export function legacyPluginEnabled(listJson: string): boolean {
  try {
    const plugins = JSON.parse(listJson);
    return Array.isArray(plugins) && plugins.some((plugin) =>
      plugin?.name === LEGACY_MODUS_AGY_PLUGIN && plugin?.enabled === true);
  } catch {
    return false;
  }
}

let legacyCleanup: Promise<void> | null = null;

/**
 * Disable (not uninstall) the legacy Modus plugin, once per backend process.
 * Disabling is reversible with `agy plugin enable modus-provider`; it is
 * Modus's own artifact, and nothing else is touched.
 */
export function disableLegacyModusPlugin(
  executable: string,
  run: typeof runAntigravityCommand = runAntigravityCommand,
): Promise<void> {
  if (legacyCleanup) return legacyCleanup;
  legacyCleanup = (async () => {
    const listed = await run(executable, ["plugin", "list", "--json"], { timeoutMs: 15_000 });
    if (listed.exitCode !== 0 || !legacyPluginEnabled(listed.stdout)) return;
    const disabled = await run(executable, ["plugin", "disable", LEGACY_MODUS_AGY_PLUGIN], { timeoutMs: 15_000 });
    if (disabled.exitCode === 0) {
      console.log(`[antigravity] disabled the legacy "${LEGACY_MODUS_AGY_PLUGIN}" agy plugin left by an earlier Modus build`);
    } else {
      console.warn(`[antigravity] could not disable the legacy "${LEGACY_MODUS_AGY_PLUGIN}" agy plugin: ${(disabled.stderr || disabled.stdout).trim().slice(0, 200)}`);
    }
  })().catch((error) => {
    console.warn(`[antigravity] legacy plugin check failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return legacyCleanup;
}

export function resetLegacyPluginCleanupForTests(): void {
  legacyCleanup = null;
}
