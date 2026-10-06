import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ActionConfig, TriggerInfo } from "./action-types";
import type { OperationReceipt, OperationResult, ProcessResult } from "./action-operation-types";
import { ACTION_MESSAGE_LIMIT, boundedMessage, OutputTail } from "./action-worker-protocol";
import { terminateProcessTree, waitForClose } from "./providers/process-tree";

export const MAX_OPERATION_RUNS = 4;
const active = new Set<AbortController>();
export function operationCapacityAvailable() { return active.size < MAX_OPERATION_RUNS; }
export function stopOperations() { for (const controller of active) controller.abort(); }

type OperationOptions = {
  config: ActionConfig;
  actionDir: string;
  artifactDir?: string;
  runId: number;
  inputs: Record<string, unknown>;
  trigger: TriggerInfo;
  controller: AbortController;
  onUpdate: (receipt: OperationReceipt) => void;
  request: (op: string, args: any) => Promise<unknown>;
  assertShell: () => void;
};

export async function executeOperation(opts: OperationOptions): Promise<{ receipt: OperationReceipt; error?: string }> {
  const { config, controller } = opts;
  const stdout = new OutputTail();
  const stderr = new OutputTail();
  const secrets = new Set<string>();
  const redact = (value: string) => {
    for (const secret of secrets) value = value.split(secret).join("[redacted]");
    return value;
  };
  const receipt: OperationReceipt = {
    version: 1, runId: opts.runId, parentRunId: opts.trigger.parentRunId,
    caller: opts.trigger.caller ?? opts.trigger.type,
    fingerprint: createHash("sha256").update(JSON.stringify(config)).update(config.execution?.type === "code" && existsSync(join(opts.actionDir, "context.ts")) ? readFileSync(join(opts.actionDir, "context.ts")) : "").digest("hex"),
    target: "backend", cwd: resolve(config.cwd ?? opts.actionDir), inputs: opts.inputs,
    outcome: "running", stdout: "", stderr: "", truncated: false,
  };
  const snapshot = () => {
    receipt.stdout = redact(stdout.text());
    receipt.stderr = redact(stderr.text());
    receipt.truncated = stdout.truncated || stderr.truncated;
    return JSON.parse(JSON.stringify(receipt), (_key, value) => typeof value === "string" ? redact(value) : value) as OperationReceipt;
  };
  if (!operationCapacityAvailable()) return { receipt: { ...receipt, outcome: "skipped" }, error: "Global operation capacity reached" };
  active.add(controller);
  const children = new Set<ChildProcess>();
  let timedOut = false;
  let primaryAborted = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs ?? 300_000);
  let persistenceError: string | undefined;
  const updates = setInterval(() => {
    try { opts.onUpdate(snapshot()); }
    catch (error) { persistenceError = String((error as Error).message); controller.abort(); }
  }, 500);
  const workerPath = existsSync(join(import.meta.dir, "action-worker.js")) ? join(import.meta.dir, "action-worker.js") : join(import.meta.dir, "action-worker.ts");
  const env = { ...process.env };

  async function terminate(child: ChildProcess) {
    if (child.connected) child.send({ version: 1, type: "cancel" }, () => {});
    // Give the worker a chance to cancel cooperatively, then force the owned
    // tree down while its root still exists so Windows cannot leave descendants.
    await new Promise(r => setTimeout(r, 100));
    await terminateProcessTree(child, true);
    if (!await waitForClose(child, 400)) await terminateProcessTree(child, true);
    if (!await waitForClose(child, 2_000)) throw new Error("Action process tree did not exit after forced termination");
  }

  async function worker(start: Record<string, unknown>, primary = false): Promise<{ result?: OperationResult; process?: ProcessResult; error?: string; couldNotStart?: boolean }> {
    controller.signal.throwIfAborted();
    if (children.size >= 5) throw new Error("At most 4 managed processes may run per code action");
    const child = spawn(process.execPath, ["--no-install", workerPath], {
      cwd: receipt.cwd, env, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.add(child);
    const out = new OutputTail();
    const err = new OutputTail();
    child.stdout?.on("data", (chunk: Buffer) => { stdout.append(chunk); out.append(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr.append(chunk); err.append(chunk); });
    try {
      const result = await new Promise<any>((resolveResult, reject) => {
        let settled = false;
        let pending = 0;
        const finish = (value: any) => {
          if (settled) return;
          settled = true;
          if (primary) {
            primaryAborted = controller.signal.aborted;
            clearTimeout(timer);
          }
          controller.signal.removeEventListener("abort", abort);
          resolveResult(value);
        };
        const abort = () => finish({ error: timedOut ? "Action timed out" : "Action cancelled" });
        controller.signal.addEventListener("abort", abort, { once: true });
        child.once("error", error => finish({ error: error.message, couldNotStart: true }));
        child.once("exit", (code, signal) => finish({ error: `Worker exited unexpectedly (${code ?? signal})` }));
        child.on("message", async (message: any) => {
          if (settled) return;
          if (!message || message.version !== 1 || !boundedMessage(message)) { finish({ error: "Invalid or oversized action worker message" }); return; }
          if (message.type === "result") { finish(message); return; }
          if (!Number.isSafeInteger(message.id) || typeof message.op !== "string" || ++pending > 8) { finish({ error: "Invalid or excessive context requests" }); return; }
          let value: unknown;
          let error: string | undefined;
          try {
            controller.signal.throwIfAborted();
            if (message.op === "process.run") {
              opts.assertShell();
              const args = message.args;
              if (!args || typeof args.executable !== "string" || (args.args !== undefined && (!Array.isArray(args.args) || args.args.some((a: unknown) => typeof a !== "string")))) throw new Error("process.run requires executable and string args");
              const result = await worker({ command: { executable: args.executable, args: args.args ?? [], shell: false }, cwd: args.cwd ? resolve(receipt.cwd, args.cwd) : receipt.cwd });
              if (result.error) throw new Error(result.error);
              value = result.process;
            } else {
              value = await opts.request(message.op, message.args);
              if (message.op === "secrets.resolve" && typeof value === "string" && value) secrets.add(value);
            }
            if (!boundedMessage(value ?? null)) throw new Error(`Context response exceeds ${ACTION_MESSAGE_LIMIT} bytes`);
          } catch (err) { error = redact(String((err as Error).message ?? err)); }
          finally { pending--; }
          if (!settled && child.connected) child.send({ version: 1, type: "reply", id: message.id, value, error }, () => {});
        });
        const message = { version: 1, type: "start", cwd: receipt.cwd, ...start };
        if (!boundedMessage(message)) { finish({ error: "Action worker start message exceeds 256 KiB" }); return; }
        child.send(message, error => { if (error) finish({ error: error.message, couldNotStart: true }); });
        if (controller.signal.aborted) abort();
      });
      await terminate(child);
      if (result.process) result.process = { ...result.process, stdout: redact(out.text()), stderr: redact(err.text()), truncated: out.truncated || err.truncated };
      return result;
    } finally { children.delete(child); }
  }

  try {
    opts.assertShell();
    for (const [name, ref] of Object.entries(config.env ?? {})) {
      const value = await opts.request("secrets.resolve", ref.secret);
      if (typeof value !== "string") throw new Error(`Missing secret reference for env.${name}`);
      if (value) secrets.add(value);
      env[name] = value;
    }
    let start: Record<string, unknown>;
    if (config.execution?.type === "command") {
      receipt.command = { executable: config.execution.executable, args: (config.execution.args ?? []).map(arg => {
        if (typeof arg === "string") return arg;
        if (opts.inputs[arg.input] === undefined) throw new Error(`Missing command input: ${arg.input}`);
        return String(opts.inputs[arg.input]);
      }), shell: config.execution.shell ?? false };
      start = { command: receipt.command };
    } else {
      start = { contextPath: join(opts.actionDir, "context.ts"), artifactDir: opts.artifactDir ?? join(opts.actionDir, "output", `run-${opts.runId}`), runId: opts.runId, actionName: config.name, inputs: { ...config.inputs, ...opts.inputs }, trigger: opts.trigger };
    }
    opts.onUpdate(snapshot());
    const result = await worker(start, true);
    if (persistenceError) throw new Error(`Unable to persist action output: ${persistenceError}`);
    receipt.exitCode = result.process?.exitCode;
    receipt.signal = result.process?.signal;
    if (primaryAborted) receipt.outcome = timedOut ? "timed-out" : "cancelled";
    else if (result.error) receipt.outcome = result.couldNotStart ? "could-not-start" : "failed";
    else if (result.process && result.process.exitCode !== 0) receipt.outcome = "failed";
    else {
      const output = result.result ?? { summary: "Command completed", data: { exitCode: result.process?.exitCode } };
      if (!output || typeof output !== "object" || Array.isArray(output) || (output.summary !== undefined && typeof output.summary !== "string") || (output.artifacts !== undefined && !Array.isArray(output.artifacts))) throw new Error("Invalid operation result");
      for (const artifact of output.artifacts ?? []) {
        if (!artifact || typeof artifact.name !== "string" || typeof artifact.path !== "string" || typeof artifact.mime !== "string") throw new Error("Invalid artifact reference");
        artifact.path = resolve(receipt.cwd, artifact.path);
        if (!statSync(artifact.path).isFile() || statSync(artifact.path).size === 0) throw new Error(`Artifact ${artifact.name} is missing or empty`);
      }
      for (const spec of config.artifacts ?? []) if (spec.required !== false && !output.artifacts?.some(a => a.name === spec.name && a.mime === spec.mime)) throw new Error(`Required artifact ${spec.name} was not returned`);
      receipt.result = output;
      receipt.outcome = "succeeded";
    }
    return { receipt: snapshot(), error: result.error ? redact(result.error) : receipt.outcome === "failed" ? `Process exited with ${receipt.exitCode ?? receipt.signal}` : undefined };
  } catch (error) {
    receipt.outcome = controller.signal.aborted ? timedOut ? "timed-out" : "cancelled" : "failed";
    return { receipt: snapshot(), error: redact(String((error as Error).message ?? error)) };
  } finally {
    clearTimeout(timer);
    clearInterval(updates);
    await Promise.allSettled([...children].map(terminate));
    active.delete(controller);
  }
}
