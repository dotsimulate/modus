import { spawn, type ChildProcess } from "child_process";
import readline from "readline";
import { attachPipeErrorHandler, pipeErrorCode, tryPipeOperation } from "../pipe-errors";
import type { CodexInput, ThreadEvent, ThreadItem, ThreadOptions } from "./codex-cli-sdk";
import { terminateProcessTree, waitForClose } from "./process-tree";

type Options = {
  executable: string;
  args: string[];
  env: Record<string, string>;
  apiKey?: string;
  mcpConfig?: Record<string, unknown>;
  spawn?: typeof spawn;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
};

class RpcError extends Error {}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

function userInput(input: CodexInput) {
  return (typeof input === "string" ? [{ type: "text" as const, text: input }] : input)
    .map((item) => item.type === "local_image"
      ? { type: "localImage", path: item.path }
      : { type: "text", text: item.text, text_elements: [] });
}

/** Adapt app-server v2 items to the provider's existing transcript renderer. */
function threadItem(item: any): ThreadItem | null {
  switch (item.type) {
    case "agentMessage": return { ...item, type: "agent_message" };
    case "reasoning": return { ...item, text: (item.summary?.length ? item.summary : item.content ?? []).join("\n") };
    case "commandExecution": return {
      ...item, type: "command_execution", aggregated_output: item.aggregatedOutput, exit_code: item.exitCode,
    };
    case "fileChange": return {
      ...item, type: "file_change",
      changes: item.changes.map((change: any) => ({ ...change, kind: change.kind.type })),
    };
    case "mcpToolCall": return { ...item, type: "mcp_tool_call" };
    case "webSearch": return { ...item, type: "web_search" };
    default: return null;
  }
}

/** One stdio app-server per Modus turn. Input stays open for turn/steer; the
 * next turn resumes the native thread in a fresh process with current config. */
export class CodexAppServerTurn {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private events: ThreadEvent[] = [];
  private wake?: () => void;
  private failure: Error | null = null;
  private finished = false;
  private closing = false;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private text = new Map<string, string>();
  private steering = new Set<Promise<boolean>>();
  private usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  private usageBaseline = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };

  constructor(private readonly options: Options) {}

  steer(input: CodexInput): Promise<boolean> {
    if (!this.threadId || !this.turnId || this.finished || this.failure || this.closing) return Promise.resolve(false);
    const expectedTurnId = this.turnId;
    const delivery = this.request("turn/steer", {
      threadId: this.threadId, expectedTurnId, input: userInput(input),
    }).then((result) => {
      if (result.turnId !== expectedTurnId) throw new Error("Codex acknowledged steering for an unexpected turn");
      return true;
    }, (error) => {
      // An explicit rejection is safe to queue. A broken connection/timeout is
      // ambiguous: propagate it instead of silently sending the message twice.
      if (error instanceof RpcError) return false;
      throw error;
    });
    this.steering.add(delivery);
    void delivery.finally(() => this.steering.delete(delivery)).catch(() => {});
    return delivery;
  }

  private emit(event: ThreadEvent): void {
    this.events.push(event);
    this.wake?.();
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.turnId = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.wake?.();
  }

  private write(message: unknown): void {
    if (this.failure) throw this.failure;
    if (!this.child?.stdin || this.closing) throw new Error("Codex app-server input is closed");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private receive(message: any): void {
    if (message.id != null && !message.method) {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new RpcError(message.error.message));
      else request.resolve(message.result);
      return;
    }
    if (message.id != null) {
      // Preserve the existing non-interactive approval contract. Never grant
      // permissions just because the new transport can receive approval RPCs.
      if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
        this.write({ id: message.id, result: { decision: "decline" } });
      } else {
        this.write({ id: message.id, error: { code: -32601, message: "Modus does not support this Codex client request" } });
      }
      return;
    }
    const p = message.params ?? {};
    // Native child agents share stdout. Their turns must never complete or
    // rekey the parent Modus session, or become targets for an interjection.
    if (!this.threadId || p.threadId !== this.threadId) return;
    if (this.finished) return;
    const eventTurnId = p.turnId ?? p.turn?.id;
    if (eventTurnId && this.turnId && eventTurnId !== this.turnId) return;
    switch (message.method) {
      case "turn/started":
        this.turnId = p.turn.id;
        this.emit({ type: "turn.started" });
        break;
      case "item/started":
      case "item/completed": {
        const item = threadItem(p.item);
        if (item) this.emit({ type: message.method === "item/started" ? "item.started" : "item.completed", item });
        break;
      }
      case "item/agentMessage/delta": {
        const text = (this.text.get(p.itemId) ?? "") + p.delta;
        this.text.set(p.itemId, text);
        this.emit({ type: "item.updated", item: { type: "agent_message", id: p.itemId, text } });
        break;
      }
      case "turn/plan/updated":
        this.emit({ type: "item.completed", item: {
          type: "todo_list", id: `plan-${p.turnId}`,
          items: p.plan.map((step: any) => ({ text: step.step, completed: step.status === "completed" })),
        } });
        break;
      case "thread/tokenUsage/updated": {
        const total = p.tokenUsage.total;
        const usage = { input_tokens: total.inputTokens, cached_input_tokens: total.cachedInputTokens, output_tokens: total.outputTokens };
        if (!this.turnId) this.usageBaseline = usage;
        else this.usage = {
          input_tokens: Math.max(0, usage.input_tokens - this.usageBaseline.input_tokens),
          cached_input_tokens: Math.max(0, usage.cached_input_tokens - this.usageBaseline.cached_input_tokens),
          output_tokens: Math.max(0, usage.output_tokens - this.usageBaseline.output_tokens),
        };
        break;
      }
      case "error":
        if (p.willRetry) this.emit({ type: "provider.reconnecting", message: p.error.message });
        // Terminal errors arrive with turn/completed; don't end on a retry.
        break;
      case "turn/completed":
        this.turnId = null;
        this.finished = true;
        if (p.turn.status === "interrupted") this.fail(abortError());
        else if (p.turn.status === "failed") this.emit({ type: "turn.failed", error: p.turn.error ?? { message: "Codex turn failed" } });
        else this.emit({ type: "turn.completed", usage: this.usage });
        break;
    }
  }

  async *run(input: CodexInput, resumeId: string | null, options: ThreadOptions, signal?: AbortSignal): AsyncGenerator<ThreadEvent> {
    if (signal?.aborted) throw abortError();
    const child = (this.options.spawn ?? spawn)(this.options.executable, this.options.args, {
      cwd: options.workingDirectory, env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
    });
    this.child = child;
    const pid = child.pid;
    if (pid != null) this.options.onSpawn?.(pid);
    // Keep error listeners attached through teardown, including late pipe errors.
    child.on("error", (error) => this.fail(error));
    child.once("exit", () => { if (pid != null) this.options.onExit?.(pid); });
    child.once("close", (code, exitSignal) => {
      if (!this.closing) this.fail(new Error(`Codex app-server closed before turn delivery finished (${exitSignal ?? code ?? "unknown"})`));
    });
    if (!child.stdin || !child.stdout) {
      this.closing = true;
      child.kill();
      throw new Error("Codex app-server requires stdin and stdout");
    }
    attachPipeErrorHandler(child.stdin, (error) => this.fail(new Error(`Codex provider input stream closed (${pipeErrorCode(error)})`)));
    // Drain stderr without storing session content or secrets in an error string.
    child.stderr?.resume();
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      try { this.receive(JSON.parse(line)); } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Invalid Codex app-server message"));
      }
    });
    rl.on("close", () => {
      if (!this.closing && !this.finished) this.fail(new Error("Codex app-server stream ended without turn completion"));
    });
    const onAbort = () => this.fail(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      await this.request("initialize", { clientInfo: { name: "modus_harness", title: "Modus", version: "1.0.0" } });
      this.write({ method: "initialized", params: {} });
      if (this.options.apiKey) {
        // The exec-only CODEX_API_KEY env var is not app-server authentication.
        // The launcher selects ephemeral storage so this cannot replace the
        // user's persisted ChatGPT login or write the key to disk.
        await this.request("account/login/start", { type: "apiKey", apiKey: this.options.apiKey });
      }
      const config: Record<string, unknown> = { ...this.options.mcpConfig };
      if (options.webSearchMode) config.web_search = options.webSearchMode;
      if (options.additionalDirectories?.length) config["sandbox_workspace_write.writable_roots"] = options.additionalDirectories;
      this.threadId = resumeId;
      const result = await this.request(resumeId ? "thread/resume" : "thread/start", {
        ...(resumeId ? { threadId: resumeId } : {}),
        model: options.model, cwd: options.workingDirectory, sandbox: options.sandboxMode, approvalPolicy: options.approvalPolicy,
        serviceTier: options.serviceTier, config,
      });
      if (typeof result.thread?.id !== "string" || (resumeId && result.thread.id !== resumeId)) {
        throw new Error("Codex did not return the requested native thread; refusing context-free replacement");
      }
      this.threadId = result.thread.id;
      yield { type: "thread.started", thread_id: this.threadId };
      await this.request("turn/start", {
        threadId: this.threadId, input: userInput(input), effort: options.modelReasoningEffort,
      });
      while (true) {
        if (this.failure) throw this.failure;
        const event = this.events.shift();
        if (event) yield event;
        else if (this.finished) break;
        else await new Promise<void>((resolve) => { this.wake = resolve; });
      }
      // A final notification can precede the response to a concurrent steer.
      // Keep stdout alive until those acknowledgments are resolved.
      await Promise.allSettled(this.steering);
    } finally {
      this.closing = true;
      signal?.removeEventListener("abort", onAbort);
      this.fail(this.failure ?? new Error("Codex turn has ended"));
      rl.close();
      tryPipeOperation(() => child.stdin!.end(), () => {});
      if (!(await waitForClose(child, 1_000))) {
        // Injected test children have no OS process tree.
        if (this.options.spawn) child.kill();
        else await terminateProcessTree(child, true);
        if (!(await waitForClose(child, 1_000))) throw new Error("Codex app-server did not confirm shutdown");
      }
    }
  }
}
