// Separate process entry point. Keep this free of harness/database imports.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join, basename } from "node:path";
import { mkdirSync } from "node:fs";
import type { CodeActionContext, CodeActionModule } from "./action-operation-types";
import { boundedMessage, ProcessExitError } from "./action-worker-protocol";

const controller = new AbortController();
let started = false;
let sequence = 0;
let codeWorker: ReturnType<typeof spawn> | undefined;
let nested = false;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
process.on("SIGTERM", () => controller.abort());

function send(message: Record<string, unknown>) {
  if (!boundedMessage(message)) throw new Error("Action worker message exceeds 256 KiB");
  process.send?.({ version: 1, ...message });
}
function request(op: string, args: unknown): Promise<any> {
  if (controller.signal.aborted) return Promise.reject(new Error("Action cancelled"));
  if (pending.size >= 8) return Promise.reject(new Error("At most 8 context requests may be pending"));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    try { send({ id, op, args }); } catch (err) { pending.delete(id); reject(err); }
  });
}

process.on("disconnect", () => {
  if (nested) process.exit(1);
  // This responsive guardian owns the tree even when authored code blocks its
  // own event loop. Parent death therefore also tears down the task.
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
  }
});
process.on("message", async (message: any) => {
  if (!message || message.version !== 1 || !boundedMessage(message)) return;
  if (codeWorker) {
    if (codeWorker.connected) codeWorker.send(message, () => {});
    return;
  }
  if (message.type === "cancel") {
    controller.abort();
    return;
  }
  if (message.type === "reply") {
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) call?.reject(new Error(message.error));
    else call?.resolve(message.value);
    return;
  }
  if (message.type !== "start" || started) return;
  started = true;
  try {
    if (!message.command && !message.executeCode) {
      codeWorker = spawn(process.execPath, [process.argv[1]!], {
        cwd: message.cwd, env: process.env, windowsHide: true,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      codeWorker.on("message", reply => {
        if (boundedMessage(reply)) process.send?.(reply);
        else send({ type: "result", error: "Oversized code worker message" });
      });
      codeWorker.once("error", error => send({ type: "result", error: error.message, couldNotStart: true }));
      codeWorker.once("exit", (code, signal) => send({ type: "result", error: `Code worker exited unexpectedly (${code ?? signal})` }));
      codeWorker.send({ ...message, executeCode: true });
      return;
    }
    nested = message.executeCode === true;
    if (message.command) {
      const { executable, args, shell } = message.command;
      const child = spawn(executable, args, {
        cwd: message.cwd, env: process.env, shell,
        windowsHide: true, stdio: ["ignore", "inherit", "inherit"],
      });
      child.once("error", error => send({ type: "result", error: error.message, couldNotStart: true }));
      child.once("exit", (exitCode, signal) => send({ type: "result", process: { exitCode, signal } }));
      // Stay alive as the ownership root until the harness tears down this tree.
      return;
    }
    const ctx: CodeActionContext = {
      runId: message.runId,
      actionName: message.actionName,
      inputs: message.inputs,
      trigger: message.trigger,
      cwd: message.cwd,
      signal: controller.signal,
      log: text => console.log(text),
      process: {
        async run(options) {
          const result = await request("process.run", options);
          if (options.check !== false && result.exitCode !== 0) throw new ProcessExitError(result);
          return result;
        },
      },
      artifacts: {
        path(filename) {
          if (!filename || basename(filename) !== filename || /[\\/:]/.test(filename) || filename === "." || filename === "..") throw new Error("Artifact filename must be a basename");
          mkdirSync(message.artifactDir, { recursive: true });
          return join(message.artifactDir, filename);
        },
      },
      secrets: { resolve: reference => request("secrets.resolve", reference) },
      actions: { trigger: (name, inputs) => request("actions.trigger", { name, inputs }) },
      sessions: { create: options => request("sessions.create", options) },
    };
    const mod = await import(pathToFileURL(message.contextPath).href) as CodeActionModule;
    if (typeof mod.run !== "function") throw new Error("Code action context.ts must export run(ctx)");
    const result = await mod.run(ctx);
    if (pending.size) throw new Error("Code action returned with unawaited context requests");
    send({ type: "result", result: result ?? {} });
  } catch (error) {
    send({ type: "result", error: String((error as Error)?.stack ?? error).slice(0, 16_384) });
  }
});
