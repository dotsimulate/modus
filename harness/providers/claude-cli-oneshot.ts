/**
 * One headless Claude CLI turn — the subprocess transport for one-shot
 * completions.
 *
 * The in-process one-shot path (`model-oneshot.ts` → pi-ai) can only reach the
 * PI provider family, which means the cheap-transform primitive was the one
 * part of Modus that could not use a Claude subscription and had to spend API
 * cash instead. The Claude CLI's print mode (`-p --output-format json`) already
 * answers a single prompt headlessly with the CLI's own auth, so this module
 * wraps exactly that: spawn, prompt on stdin, one JSON result object back.
 *
 * It is deliberately not interchangeable with the in-process path: a subprocess
 * launch costs seconds where an HTTP call costs milliseconds, so callers must
 * opt in (`allowSubprocess` in `model-oneshot.ts`) and results carry their
 * transport. Tools are disabled (`--tools ""`) and turns capped at one — a
 * one-shot is prompt in, text out, and anything that wants tools wants a
 * session.
 *
 * Flags verified against claude CLI 2.1.215 (`--output-format json`,
 * `--tools ""`, `--max-turns`, `--system-prompt-file`, `--effort`). Note
 * `--max-turns` is absent from `--help` but present in the binary and used by
 * the PTY session provider. There is no CLI flag for temperature or maxTokens;
 * the caller-facing contract documents both as ignored on this transport.
 */

import { spawn } from "child_process";
import { getMemoryLimitedEnv } from "../memory-guard";
import { providerChildEnv } from "./child-env";
import { resolveCli } from "./resolve-cli";
import {
  createSensitiveTempDirectory,
  removeSensitiveTempDirectory,
  writeSensitiveTempFile,
} from "../sensitive-temp";

// Same resolution as the PTY session provider (claude-code-pty.ts).
const CLAUDE_PATH = process.env.CLAUDE_PATH
  || (process.platform === "win32" ? "claude.cmd" : resolveCli("claude") ?? "claude");

/** A stuck CLI must not hang a one-shot forever; print mode has no legitimate
 *  reason to run this long with tools disabled. */
export const CLI_ONE_SHOT_TIMEOUT_MS = 120_000;

export type CliOneShotRequest = {
  prompt: string;
  system?: string;
  /** Model id or CLI alias. Omitted = the CLI's own default. */
  model?: string;
  effort?: string;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type CliOneShotOutcome = {
  text: string;
  /** The model the CLI actually billed the answer to (see pickPrimaryModel). */
  model?: string;
  usage?: { input: number; output: number; totalTokens: number; costUsd: number };
};

// ── Pure pieces (tested directly) ──

export function buildOneShotArgv(opts: {
  model?: string;
  effort?: string;
  systemPromptFile?: string;
} = {}): string[] {
  const args = [
    "-p",                        // headless/print mode
    "--output-format", "json",   // one result object, not NDJSON
    "--max-turns", "1",
    "--tools", "",               // no built-in tools: prompt in, text out
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort && opts.effort !== "off") args.push("--effort", opts.effort);
  if (opts.systemPromptFile) args.push("--system-prompt-file", opts.systemPromptFile);
  return args;
}

/**
 * The `modelUsage` map lists every model the run touched, including the CLI's
 * own small helper calls (a haiku entry shows up alongside the answering
 * model). The primary model is the one the answer cost the most on — by
 * reported cost first, token volume as the tiebreaker for gateways that report
 * zero cost.
 */
export function pickPrimaryModel(
  modelUsage: Record<string, { costUSD?: number; inputTokens?: number; outputTokens?: number }> | undefined,
): string | undefined {
  if (!modelUsage) return undefined;
  let best: string | undefined;
  let bestCost = -1;
  let bestTokens = -1;
  for (const [model, usage] of Object.entries(modelUsage)) {
    const cost = usage?.costUSD ?? 0;
    const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    if (cost > bestCost || (cost === bestCost && tokens > bestTokens)) {
      best = model;
      bestCost = cost;
      bestTokens = tokens;
    }
  }
  return best;
}

/**
 * Parse `--output-format json` stdout. The CLI emits a single JSON object with
 * `type: "result"`, but scan lines defensively from the end in case anything
 * else leaks onto stdout ahead of it.
 */
export function parseCliOneShotOutput(stdout: string): CliOneShotOutcome {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let result: any;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && parsed.type === "result") {
        result = parsed;
        break;
      }
    } catch {
      // not JSON — keep scanning
    }
  }
  if (!result) {
    const tail = stdout.trim().slice(-300);
    throw new Error(`claude CLI printed no result object${tail ? ` — output ended: ${tail}` : " — output was empty"}`);
  }

  if (result.is_error === true || (result.subtype && result.subtype !== "success")) {
    const detail = typeof result.result === "string" && result.result.trim()
      ? result.result.trim().slice(0, 300)
      : "no error detail";
    throw new Error(`claude CLI reported ${result.subtype ?? "an error"} — ${detail}`);
  }

  const usage = result.usage && typeof result.usage === "object"
    ? {
        input: result.usage.input_tokens ?? 0,
        output: result.usage.output_tokens ?? 0,
        totalTokens: (result.usage.input_tokens ?? 0) + (result.usage.output_tokens ?? 0),
        costUsd: result.total_cost_usd ?? 0,
      }
    : undefined;

  return {
    text: typeof result.result === "string" ? result.result.trim() : "",
    model: pickPrimaryModel(result.modelUsage),
    usage,
  };
}

// ── The spawn ──

export async function runClaudeCliOneShot(req: CliOneShotRequest): Promise<CliOneShotOutcome> {
  if (req.signal?.aborted) throw new Error("one-shot: aborted before the CLI was launched");

  let sensitiveTempDir: string | null = null;
  let systemPromptFile: string | undefined;
  if (req.system) {
    // Same mechanism as the session provider: a temp file dodges the Windows
    // command-line length limit that silently truncates long inline args.
    sensitiveTempDir = createSensitiveTempDirectory();
    systemPromptFile = writeSensitiveTempFile(sensitiveTempDir, "system-prompt.txt", req.system);
  }

  const args = buildOneShotArgv({ model: req.model, effort: req.effort, systemPromptFile });
  const timeoutMs = req.timeoutMs ?? CLI_ONE_SHOT_TIMEOUT_MS;

  try {
    const proc = spawn(CLAUDE_PATH, args, {
      cwd: req.cwd ?? process.cwd(),
      env: getMemoryLimitedEnv(providerChildEnv()),
      stdio: ["pipe", "pipe", "pipe"],
      // A dedicated POSIX process group so a kill reaches any descendants;
      // Windows uses taskkill /T below.
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    proc.stderr?.on("data", (chunk) => { stderr += String(chunk); });

    const killTree = () => {
      const pid = proc.pid;
      if (!pid) return;
      if (process.platform === "win32") {
        try {
          spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        } catch { /* already gone */ }
      } else {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      }
    };

    const exit = await new Promise<{ code: number | null; timedOut: boolean; aborted: boolean }>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let aborted = false;
      const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
      const onAbort = () => { aborted = true; killTree(); };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      proc.on("error", (error) => finish(() => reject(error)));
      // "close", not "exit": stdout must be fully drained before parsing.
      proc.on("close", (code) => finish(() => resolve({ code, timedOut, aborted })));
      try {
        proc.stdin?.write(req.prompt);
        proc.stdin?.end();
      } catch (error) {
        killTree();
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });

    if (exit.aborted) throw new Error("one-shot: aborted while the CLI was running");
    if (exit.timedOut) throw new Error(`one-shot: claude CLI produced no result within ${timeoutMs}ms`);
    if (exit.code !== 0 && !stdout.trim()) {
      const detail = stderr.trim().slice(-300) || `exit code ${exit.code}`;
      throw new Error(`one-shot: claude CLI failed — ${detail}`);
    }
    // A nonzero exit with output still on stdout usually carries a structured
    // error result; parseCliOneShotOutput turns that into the better message.
    return parseCliOneShotOutput(stdout);
  } finally {
    if (sensitiveTempDir) {
      try {
        removeSensitiveTempDirectory(sensitiveTempDir);
      } catch {
        console.warn("[claude-cli-oneshot] could not clean up the system prompt temp file");
      }
    }
  }
}
