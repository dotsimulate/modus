import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "child_process";
import { attachPipeErrorHandler, pipeErrorCode, tryPipeOperation } from "../pipe-errors";
import { redactProviderDiagnostic } from "./provider-diagnostics";
import { hasExited, terminateProcessTree, waitForClose } from "./process-tree";

export type JsonRpcId = string | number;

export type GrokAcpClientOptions = {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class GrokAcpClient {
  private readonly options: GrokAcpClientOptions;
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private pending = new Map<JsonRpcId, PendingRequest>();
  private notificationHandler?: (method: string, params: any) => void | Promise<void>;
  private requestHandler?: (id: JsonRpcId, method: string, params: any) => void | Promise<void>;
  private closeHandler?: (error: Error | null) => void;

  constructor(options: GrokAcpClientOptions) {
    this.options = options;
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  get stderr(): string {
    return this.stderrBuffer;
  }

  get running(): boolean {
    return !!this.process && !hasExited(this.process);
  }

  onNotification(handler: (method: string, params: any) => void | Promise<void>): void {
    this.notificationHandler = handler;
  }

  onRequest(handler: (id: JsonRpcId, method: string, params: any) => void | Promise<void>): void {
    this.requestHandler = handler;
  }

  onClose(handler: (error: Error | null) => void): void {
    this.closeHandler = handler;
  }

  start(): void {
    if (this.process) throw new Error("Grok ACP process already started");
    const child = spawn(this.options.executable, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.appendDiagnostic(chunk);
    });
    attachPipeErrorHandler(child.stdin, (error) => {
      this.appendDiagnostic(`Provider input stream closed (${pipeErrorCode(error)}).`);
      void terminateProcessTree(child, true);
    });
    child.once("error", (error) => this.finish(error));
    child.once("close", (code, signal) => {
      const error = code === 0 || child.killed
        ? null
        : new Error(this.stderrBuffer.trim() || `Grok ACP exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`);
      this.finish(error);
    });
  }

  request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 120_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Grok ACP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async close(graceMs = 1_000): Promise<void> {
    const child = this.process;
    if (!child || hasExited(child)) return;
    tryPipeOperation(
      () => child.stdin.end(),
      (error) => this.appendDiagnostic(`Provider input stream close failed (${pipeErrorCode(error)}).`),
    );
    if (await waitForClose(child, graceMs)) return;
    await terminateProcessTree(child, true);
    if (!(await waitForClose(child, 1_000))) {
      this.appendDiagnostic("Provider process tree did not confirm closure after forced termination.");
    }
  }

  private write(message: unknown): void {
    if (!this.process || !this.running || !this.process.stdin.writable) {
      throw new Error("Grok ACP process is not running");
    }
    const child = this.process;
    const wrote = tryPipeOperation(
      () => child.stdin.write(`${JSON.stringify(message)}\n`),
      (error) => this.appendDiagnostic(`Provider input stream write failed (${pipeErrorCode(error)}).`),
    );
    if (!wrote) throw new Error("Grok ACP input stream is closed");
  }

  private appendDiagnostic(value: string): void {
    const safe = redactProviderDiagnostic(value);
    this.stderrBuffer = (this.stderrBuffer + `\n${safe}`).slice(-16_384);
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.appendDiagnostic(`Unexpected Grok stdout: ${line}`);
      return;
    }
    if (message && message.id != null && ("result" in message || "error" in message) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(redactProviderDiagnostic(message.error.message ?? JSON.stringify(message.error))));
      }
      else pending.resolve(message.result);
      return;
    }
    if (message && message.id != null && typeof message.method === "string") {
      if (!this.requestHandler) {
        try { this.respondError(message.id, -32601, `Unsupported client method: ${message.method}`); } catch {}
        return;
      }
      const respondWithHandlerError = (error: unknown) => {
        try {
          this.respondError(
            message.id,
            -32603,
            redactProviderDiagnostic(error instanceof Error ? error.message : String(error)),
          );
        } catch { /* process already closed */ }
      };
      try {
        Promise.resolve(this.requestHandler(message.id, message.method, message.params))
          .catch(respondWithHandlerError);
      } catch (error) {
        respondWithHandlerError(error);
      }
      return;
    }
    if (message && typeof message.method === "string") {
      try {
        Promise.resolve(this.notificationHandler?.(message.method, message.params)).catch(() => {});
      } catch { /* isolate provider notifications from the backend event loop */ }
    }
  }

  private finish(error: Error | null): void {
    if (!this.process) return;
    this.process = null;
    const terminalError = error ?? new Error("Grok ACP process closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(terminalError);
    }
    this.pending.clear();
    try { this.closeHandler?.(error); } catch { /* isolate provider cleanup callbacks */ }
  }
}
