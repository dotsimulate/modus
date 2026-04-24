import { Database } from "bun:sqlite";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import readline from "readline";

export type ApprovalMode = "never" | "on-request" | "untrusted" | "on-failure";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type WebSearchMode = "disabled" | "cached" | "live";
export type ModelReasoningEffort = "low" | "medium" | "high";

export type ThreadOptions = {
  model?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: ModelReasoningEffort;
  webSearchMode?: WebSearchMode;
  approvalPolicy?: ApprovalMode;
  additionalDirectories?: string[];
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

type TextInput = { type: "text"; text: string };
type ImageInput = { type: "local_image"; path: string };
type Input = string | Array<TextInput | ImageInput>;

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
};

const INTERNAL_ORIGINATOR_ENV = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
const HARNESS_ORIGINATOR = "modus_harness";
const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function getCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function resolveCodexExecutable(): string {
  return process.env.CODEX_PATH
    ?? Bun.which("codex")
    ?? (() => {
      throw new Error("Codex CLI not found in PATH. Install Codex and ensure `codex` is available.");
    })();
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

function normalizeInput(input: Input): { prompt: string; images: string[] } {
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
  ) {}

  async *run(args: RunArgs): AsyncGenerator<string> {
    const commandArgs = ["exec", "--json", "--color", "never"];
    if (this.configOverrides) {
      for (const override of serializeConfigOverrides(this.configOverrides)) {
        commandArgs.push("--config", override);
      }
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
    if (args.threadId) commandArgs.push("resume", args.threadId);
    if (args.images?.length) {
      for (const image of args.images) commandArgs.push("--image", image);
    }

    const env = this.envOverride ? { ...this.envOverride } : Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    if (!env[INTERNAL_ORIGINATOR_ENV]) env[INTERNAL_ORIGINATOR_ENV] = HARNESS_ORIGINATOR;
    if (args.baseUrl) env.OPENAI_BASE_URL = args.baseUrl;
    if (args.apiKey) env.CODEX_API_KEY = args.apiKey;

    const child = spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal,
    });
    let spawnError: Error | null = null;
    child.once("error", (err) => {
      spawnError = err;
    });

    if (!child.stdin) {
      child.kill();
      throw new Error("Codex child process has no stdin");
    }
    child.stdin.write(args.input);
    child.stdin.end();

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
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        yield line;
      }
      if (spawnError) throw spawnError;
      const { code, signal } = await exitPromise;
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

  async runStreamed(input: Input, turnOptions: TurnOptions = {}): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    return { events: this.runStreamedInternal(input, turnOptions) };
  }

  private async *runStreamedInternal(input: Input, turnOptions: TurnOptions): AsyncGenerator<ThreadEvent> {
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
    this.exec = new CodexExec(options.codexPathOverride, options.env, options.config);
  }

  startThread(options: ThreadOptions = {}): Thread {
    return new Thread(this.exec, this.options, options);
  }

  resumeThread(id: string, options: ThreadOptions = {}): Thread {
    return new Thread(this.exec, this.options, options, id);
  }
}
