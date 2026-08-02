import { Database } from "bun:sqlite";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import readline from "readline";
import { attachPipeErrorHandler, pipeErrorCode, tryPipeOperation } from "../pipe-errors";
import { providerChildEnv } from "./child-env";
import { resolveCli } from "./resolve-cli";

type SpawnFn = typeof spawn;

export type ApprovalMode = "never" | "on-request" | "untrusted" | "on-failure";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type WebSearchMode = "disabled" | "cached" | "live";
export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ServiceTier = "standard" | "fast" | "priority";

export type ThreadOptions = {
  model?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: ModelReasoningEffort;
  webSearchMode?: WebSearchMode;
  approvalPolicy?: ApprovalMode;
  additionalDirectories?: string[];
  enableFeatures?: string[];
  disableFeatures?: string[];
  serviceTier?: ServiceTier;
};

export type ThreadItem = {
  type: string;
  id?: string;
  [key: string]: any;
};

export type ThreadEvent = {
  type: string;
  [key: string]: any;
};

export type CodexReconnectNotice = {
  attempt: number;
  maxAttempts: number;
  message: string;
};

/** Codex can emit a turn.failed-shaped progress notice while its transport is
 * still reconnecting. Only the explicit N/M form is transient. */
export function parseCodexReconnectNotice(message: string): CodexReconnectNotice | null {
  const match = /^Reconnecting\.\.\.\s+(\d+)\/(\d+)\s+\(stream disconnected before completion:/i.exec(message.trim());
  if (!match) return null;
  const attempt = Number(match[1]);
  const maxAttempts = Number(match[2]);
  if (!Number.isInteger(attempt) || !Number.isInteger(maxAttempts) || attempt < 1 || maxAttempts < attempt) return null;
  return { attempt, maxAttempts, message };
}

type TextInput = { type: "text"; text: string };
type ImageInput = { type: "local_image"; path: string };
export type CodexInput = string | Array<TextInput | ImageInput>;

type TurnOptions = {
  signal?: AbortSignal;
};

type RunArgs = {
  input: string;
  baseUrl?: string;
  apiKey?: string;
  threadId?: string | null;
  images?: string[];
  model?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: ModelReasoningEffort;
  signal?: AbortSignal;
  webSearchMode?: WebSearchMode;
  approvalPolicy?: ApprovalMode;
  additionalDirectories?: string[];
  enableFeatures?: string[];
  disableFeatures?: string[];
  serviceTier?: ServiceTier;
};

type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
type CodexConfigObject = {
  [key: string]: CodexConfigValue;
};

type CodexOptions = {
  apiKey?: string;
  baseUrl?: string;
  codexPathOverride?: string;
  env?: Record<string, string>;
  config?: CodexConfigObject;
  spawnOverride?: SpawnFn;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
};

const INTERNAL_ORIGINATOR_ENV = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
const HARNESS_ORIGINATOR = "modus_harness";
const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function getCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function resolveCodexExecutable(): string {
  if (process.env.CODEX_PATH) return process.env.CODEX_PATH;
  const shim = resolveCli("codex");
  if (!shim) throw new Error("Codex CLI not found in PATH. Install Codex and ensure `codex` is available.");
  if (process.platform !== "win32") return shim;

  // The npm shim launches node -> native codex.exe. Killing/tracking only the
  // Node wrapper can orphan a native task that keeps editing after Modus has
  // declared the turn finished. Prefer the packaged native binary so the PID
  // Modus owns is the process that actually performs the task.
  const packageName = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const npmRoot = dirname(shim);
  const candidates = [
    join(npmRoot, "node_modules", "@openai", "codex", "node_modules", "@openai", packageName, "vendor", target, "bin", "codex.exe"),
    join(npmRoot, "node_modules", "@openai", packageName, "vendor", target, "bin", "codex.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? shim;
}

/**
 * Whether a codex CLI version accepts `--enable`/`--disable` feature flags.
 * Feature flags landed in 0.136; passing one to an older CLI fails the whole
 * exec with "Unknown feature flag" before the turn can start. Returns null
 * when the version string is unrecognizable.
 */
export function codexVersionSupportsFeatureFlags(versionOutput: string): boolean | null {
  const match = versionOutput.match(/(\d+)\.(\d+)\.\d+/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 136;
}

// Probed once per executable per process. Unknown versions pass flags through
// unchanged — current CLIs accept them, and a probe failure must not change
// behavior for the installs that already work.
let featureFlagSupport: { executable: string; supported: boolean } | null = null;

function supportsFeatureFlags(executable: string): boolean {
  if (featureFlagSupport?.executable === executable) return featureFlagSupport.supported;
  let supported = true;
  try {
    const probe = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "pipe" });
    const output = new TextDecoder().decode(probe.stdout);
    supported = codexVersionSupportsFeatureFlags(output) ?? true;
    if (!supported) {
      console.log(`[codex] ${output.trim() || executable} predates feature flags; skipping --enable/--disable`);
    }
  } catch {
    supported = true;
  }
  featureFlagSupport = { executable, supported };
  return supported;
}

export function canResumeCodexThread(threadId: string): boolean {
  const statePath = join(getCodexHome(), "state_5.sqlite");
  if (!existsSync(statePath)) return false;

  let db: Database | null = null;
  try {
    db = new Database(statePath, { readonly: true });
    const row = db.query("SELECT rollout_path FROM threads WHERE id = ? LIMIT 1")
      .get(threadId) as { rollout_path?: string } | null;
    return !!row?.rollout_path && existsSync(row.rollout_path);
  } catch (err) {
    console.warn(`[codex] Failed to inspect local Codex thread state for ${threadId}:`, err);
    return false;
  } finally {
    try { db?.close(); } catch { /* ignore cleanup errors */ }
  }
}

function normalizeInput(input: CodexInput): { prompt: string; images: string[] } {
  if (typeof input === "string") {
    return { prompt: input, images: [] };
  }

  const promptParts: string[] = [];
  const images: string[] = [];
  for (const item of input) {
    if (item.type === "text") promptParts.push(item.text);
    if (item.type === "local_image") images.push(item.path);
  }
  return { prompt: promptParts.join("\n\n"), images };
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatTomlKey(key: string): string {
  return TOML_BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function toTomlValue(value: CodexConfigValue, path: string): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Codex config override at ${path} must be a finite number`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => toTomlValue(item, `${path}[${index}]`)).join(", ")}]`;
  }
  if (isPlainObject(value)) {
    const parts: string[] = [];
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      parts.push(`${formatTomlKey(key)} = ${toTomlValue(child as CodexConfigValue, `${path}.${key}`)}`);
    }
    return `{${parts.join(", ")}}`;
  }
  throw new Error(`Unsupported Codex config override at ${path}`);
}

function flattenConfigOverrides(value: CodexConfigObject, prefix: string, overrides: string[]): void {
  const entries = Object.entries(value);
  if (!prefix && entries.length === 0) return;
  if (prefix && entries.length === 0) {
    overrides.push(`${prefix}={}`);
    return;
  }

  for (const [key, child] of entries) {
    if (child === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      flattenConfigOverrides(child as CodexConfigObject, path, overrides);
    } else {
      overrides.push(`${path}=${toTomlValue(child, path)}`);
    }
  }
}

function serializeConfigOverrides(configOverrides: CodexConfigObject): string[] {
  const overrides: string[] = [];
  flattenConfigOverrides(configOverrides, "", overrides);
  return overrides;
}

class CodexExec {
  constructor(
    private readonly executablePath: string = resolveCodexExecutable(),
    private readonly envOverride?: Record<string, string>,
    private readonly configOverrides?: CodexConfigObject,
    private readonly spawnFn: SpawnFn = spawn,
    private readonly onSpawn?: (pid: number) => void,
    private readonly onExit?: (pid: number) => void,
  ) {}

  async *run(args: RunArgs): AsyncGenerator<string> {
    const commandArgs = ["exec", "--json", "--color", "never"];
    if (this.configOverrides) {
      for (const override of serializeConfigOverrides(this.configOverrides)) {
        commandArgs.push("--config", override);
      }
    }
    if ((args.enableFeatures?.length || args.disableFeatures?.length) && supportsFeatureFlags(this.executablePath)) {
      for (const feature of args.enableFeatures ?? []) commandArgs.push("--enable", feature);
      for (const feature of args.disableFeatures ?? []) commandArgs.push("--disable", feature);
    }
    if (args.model) commandArgs.push("--model", args.model);
    if (args.sandboxMode) commandArgs.push("--sandbox", args.sandboxMode);
    if (args.workingDirectory) commandArgs.push("--cd", args.workingDirectory);
    if (args.additionalDirectories?.length) {
      for (const dir of args.additionalDirectories) commandArgs.push("--add-dir", dir);
    }
    if (args.skipGitRepoCheck) commandArgs.push("--skip-git-repo-check");
    if (args.modelReasoningEffort) commandArgs.push("--config", `model_reasoning_effort="${args.modelReasoningEffort}"`);
    if (args.webSearchMode) commandArgs.push("--config", `web_search="${args.webSearchMode}"`);
    if (args.approvalPolicy) commandArgs.push("--config", `approval_policy="${args.approvalPolicy}"`);
    if (args.serviceTier) commandArgs.push("--config", `service_tier="${args.serviceTier}"`);
    if (args.threadId) commandArgs.push("resume", args.threadId);
    if (args.images?.length) {
      for (const image of args.images) commandArgs.push("--image", image);
    }

    const env = this.envOverride ? { ...this.envOverride } : providerChildEnv();
    if (!env[INTERNAL_ORIGINATOR_ENV]) env[INTERNAL_ORIGINATOR_ENV] = HARNESS_ORIGINATOR;
    if (args.baseUrl) env.OPENAI_BASE_URL = args.baseUrl;
    if (args.apiKey) env.CODEX_API_KEY = args.apiKey;

    const child = this.spawnFn(this.executablePath, commandArgs, {
      cwd: args.workingDirectory,
      env,
      signal: args.signal,
    });
    const childPid = typeof child.pid === "number" ? child.pid : null;
    if (childPid != null) this.onSpawn?.(childPid);
    let spawnError: Error | null = null;
    child.once("error", (err) => {
      spawnError = err;
    });

    if (!child.stdin) {
      child.kill();
      throw new Error("Codex child process has no stdin");
    }
    attachPipeErrorHandler(child.stdin, (error) => {
      spawnError ??= new Error(`Codex provider input stream closed (${pipeErrorCode(error)})`);
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
    });
    const wroteInput = tryPipeOperation(
      () => {
        child.stdin!.write(args.input);
        child.stdin!.end();
      },
      (error) => {
        spawnError ??= new Error(`Codex provider input stream closed (${pipeErrorCode(error)})`);
        try { child.kill("SIGKILL"); } catch { /* best effort */ }
      },
    );
    if (!wroteInput && spawnError) throw spawnError;

    if (!child.stdout) {
      child.kill();
      throw new Error("Codex child process has no stdout");
    }

    const stderrChunks: Buffer[] = [];
    if (child.stderr) {
      child.stderr.on("data", (data) => {
        stderrChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      });
    }

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => {
        if (childPid != null) this.onExit?.(childPid);
        resolve({ code, signal });
      });
    });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        if (args.signal?.aborted) throw createAbortError();
        yield line;
      }
      const err = spawnError as Error | null;
      if (err) {
        if (args.signal?.aborted || err.name === "AbortError") throw createAbortError();
        throw err;
      }
      const { code, signal } = await exitPromise;
      if (args.signal?.aborted) throw createAbortError();
      if (code !== 0 || signal) {
        const stderrBuffer = Buffer.concat(stderrChunks);
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        throw new Error(`Codex exec exited with ${detail}: ${stderrBuffer.toString("utf8")}`);
      }
    } finally {
      rl.close();
      child.removeAllListeners();
      try {
        if (!child.killed) child.kill();
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

export class Thread {
  constructor(
    private readonly exec: CodexExec,
    private readonly options: CodexOptions,
    private readonly threadOptions: ThreadOptions,
    private threadId: string | null = null,
  ) {}

  async runStreamed(input: CodexInput, turnOptions: TurnOptions = {}): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    return { events: this.runStreamedInternal(input, turnOptions) };
  }

  private async *runStreamedInternal(input: CodexInput, turnOptions: TurnOptions): AsyncGenerator<ThreadEvent> {
    const { prompt, images } = normalizeInput(input);
    for await (const line of this.exec.run({
      input: prompt,
      baseUrl: this.options.baseUrl,
      apiKey: this.options.apiKey,
      threadId: this.threadId,
      images,
      model: this.threadOptions.model,
      sandboxMode: this.threadOptions.sandboxMode,
      workingDirectory: this.threadOptions.workingDirectory,
      skipGitRepoCheck: this.threadOptions.skipGitRepoCheck,
      modelReasoningEffort: this.threadOptions.modelReasoningEffort,
      signal: turnOptions.signal,
      webSearchMode: this.threadOptions.webSearchMode,
      approvalPolicy: this.threadOptions.approvalPolicy,
      additionalDirectories: this.threadOptions.additionalDirectories,
      enableFeatures: this.threadOptions.enableFeatures,
      disableFeatures: this.threadOptions.disableFeatures,
      serviceTier: this.threadOptions.serviceTier,
    })) {
      let parsed: ThreadEvent;
      try {
        parsed = JSON.parse(line) as ThreadEvent;
      } catch (error) {
        throw new Error(`Failed to parse Codex event: ${line}`, { cause: error });
      }
      if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
        this.threadId = parsed.thread_id;
      }
      yield parsed;
    }
  }
}

export class Codex {
  private readonly exec: CodexExec;
  constructor(private readonly options: CodexOptions = {}) {
    this.exec = new CodexExec(
      options.codexPathOverride,
      options.env,
      options.config,
      options.spawnOverride,
      options.onSpawn,
      options.onExit,
    );
  }

  startThread(options: ThreadOptions = {}): Thread {
    return new Thread(this.exec, this.options, options);
  }

  resumeThread(id: string, options: ThreadOptions = {}): Thread {
    return new Thread(this.exec, this.options, options, id);
  }
}
