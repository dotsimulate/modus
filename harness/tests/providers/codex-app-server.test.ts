import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough, Writable } from "stream";
// Other provider suites replace this module with mock.module. Load a distinct
// instance, as codex-cli-sdk.test.ts does, so this exercises the real transport.
const { Codex } = await import(`../../providers/codex-cli-sdk.ts?app-server-test=${Date.now()}`);

class FakeServer extends EventEmitter {
  pid = 43210;
  exitCode: number | null = null;
  signalCode = null;
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();
  messages: any[] = [];
  hook?: (message: any) => boolean;
  stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      const message = JSON.parse(chunk.toString());
      this.messages.push(message);
      queueMicrotask(() => {
        if (this.hook?.(message)) return;
        if (message.method === "initialize") this.reply(message, {});
        if (message.method === "account/login/start") this.reply(message, { type: "apiKey" });
        if (message.method === "thread/start" || message.method === "thread/resume") this.reply(message, { thread: { id: "thread-1" } });
        if (message.method === "turn/start") {
          this.notify("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
          this.reply(message, { turn: { id: "turn-1", status: "inProgress" } });
        }
        if (message.method === "turn/steer") this.reply(message, { turnId: "turn-1" });
      });
      callback();
    },
    final: (callback) => { this.close(); callback(); },
  });

  send(message: unknown) { this.stdout.write(JSON.stringify(message) + "\n"); }
  reply(request: any, result: unknown) { this.send({ id: request.id, result }); }
  notify(method: string, params: Record<string, unknown> = {}) {
    this.send({ method, params: { threadId: "thread-1", turnId: "turn-1", ...params } });
  }
  complete(status = "completed") { this.notify("turn/completed", { turn: { id: "turn-1", status, error: { message: "turn failed" } } }); }
  close() {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }
  kill() { this.killed = true; this.close(); return true; }
}

function setup(threadOptions = {}, resumeId?: string, clientOptions = {}) {
  const server = new FakeServer();
  const spawns: any[] = [];
  const lifecycle: string[] = [];
  const codex = new Codex({
    ...clientOptions, transport: "app-server", codexPathOverride: "fake-codex",
    spawnOverride: ((command: string, args: string[], options: unknown) => {
      spawns.push({ command, args, options });
      return server;
    }) as any,
    onSpawn: (pid: number) => lifecycle.push(`spawn:${pid}`),
    onExit: (pid: number) => lifecycle.push(`exit:${pid}`),
  });
  const thread = resumeId ? codex.resumeThread(resumeId, threadOptions) : codex.startThread(threadOptions);
  return { server, spawns, lifecycle, thread };
}

async function running(fixture: ReturnType<typeof setup>, input: any = "start", signal?: AbortSignal) {
  const seen: any[] = [];
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const { events } = await fixture.thread.runStreamed(input, { signal });
  const done = (async () => {
    for await (const event of events) {
      seen.push(event);
      if (event.type === "turn.started") ready();
    }
  })();
  await Promise.race([started, done]);
  return { seen, done };
}

describe("Codex app-server steering", () => {
  test("acknowledges live steering on the same turn without interruption or another process", async () => {
    const f = setup();
    let request: any;
    f.server.hook = (message) => {
      if (message.method !== "turn/steer") return false;
      request = message;
      return true;
    };
    const run = await running(f);
    let acknowledged = false;
    const delivery = f.thread.steer("Also check the tests").then((accepted) => { acknowledged = accepted; return accepted; });
    await Bun.sleep(0);
    expect(acknowledged).toBe(false);
    expect(request.params).toEqual({
      threadId: "thread-1", expectedTurnId: "turn-1",
      input: [{ type: "text", text: "Also check the tests", text_elements: [] }],
    });
    expect(f.server.stdin.writableEnded).toBe(false);
    f.server.reply(request, { turnId: "turn-1" });
    expect(await delivery).toBe(true);
    f.server.complete();
    await run.done;
    expect(f.spawns).toHaveLength(1);
    expect(f.server.messages.filter((m) => m.method === "turn/start")).toHaveLength(1);
    expect(f.server.messages.some((m) => m.method === "turn/interrupt")).toBe(false);
    expect(f.server.killed).toBe(false);
    expect(f.lifecycle).toEqual(["spawn:43210", "exit:43210"]);
    expect(await f.thread.steer("too late")).toBe(false);
  });

  test("an explicit rejection declines steering so Modus can queue it", async () => {
    const f = setup();
    f.server.hook = (message) => {
      if (message.method !== "turn/steer") return false;
      f.server.send({ id: message.id, error: { code: -32600, message: "no active turn" } });
      return true;
    };
    const run = await running(f);
    expect(await f.thread.steer("late input")).toBe(false);
    f.server.complete();
    await run.done;
  });

  test("keeps the channel open when completion precedes a steering acknowledgment", async () => {
    const f = setup();
    let request: any;
    f.server.hook = (message) => {
      if (message.method !== "turn/steer") return false;
      request = message;
      f.server.complete();
      return true;
    };
    const run = await running(f);
    const delivery = f.thread.steer("last detail");
    await Bun.sleep(0);
    expect(f.server.stdin.writableEnded).toBe(false);
    f.server.reply(request, { turnId: "turn-1" });
    expect(await delivery).toBe(true);
    await run.done;
  });

  test("a broken connection does not claim that unacknowledged input is safe to resend", async () => {
    const f = setup();
    f.server.hook = (message) => {
      if (message.method !== "turn/steer") return false;
      f.server.close();
      return true;
    };
    const run = await running(f);
    const delivery = f.thread.steer("uncertain");
    void delivery.catch(() => {});
    const checks = [expect(run.done).rejects.toThrow(), expect(delivery).rejects.toThrow()];
    await Promise.all(checks);
  });

  test("ignores child-agent events and preserves parent text, tools, retry notices and usage", async () => {
    const f = setup();
    const run = await running(f);
    f.server.notify("turn/started", { threadId: "child", turn: { id: "child-turn" } });
    f.server.notify("item/completed", { threadId: "child", item: { type: "agentMessage", id: "child-msg", text: "child only" } });
    f.server.notify("turn/completed", { threadId: "child", turn: { id: "child-turn", status: "completed" } });
    expect(await f.thread.steer("parent detail")).toBe(true);
    f.server.notify("item/agentMessage/delta", { itemId: "reply", delta: "hello " });
    f.server.notify("item/agentMessage/delta", { itemId: "reply", delta: "world" });
    f.server.notify("item/completed", { item: { type: "commandExecution", id: "cmd", command: "test", status: "completed", aggregatedOutput: "passed", exitCode: 0 } });
    f.server.notify("item/completed", { item: { type: "reasoning", id: "reason", summary: ["summary"], content: [] } });
    f.server.notify("item/completed", { item: { type: "fileChange", id: "edit", status: "completed", changes: [{ path: "test.ts", kind: { type: "update" }, diff: "diff" }] } });
    f.server.notify("item/completed", { item: { type: "mcpToolCall", id: "mcp", server: "test", tool: "check", result: { content: [{ type: "text", text: "ok" }] } } });
    f.server.notify("error", { willRetry: true, error: { message: "reconnecting" } });
    f.server.notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 30, cachedInputTokens: 10, outputTokens: 5 } } });
    f.server.complete();
    await run.done;
    expect(run.seen.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(run.seen.find((e) => e.item?.id === "child-msg")).toBeUndefined();
    expect(run.seen.filter((e) => e.type === "item.updated").at(-1)?.item.text).toBe("hello world");
    expect(run.seen.find((e) => e.item?.id === "cmd")?.item).toMatchObject({ type: "command_execution", aggregated_output: "passed", exit_code: 0 });
    expect(run.seen.find((e) => e.item?.id === "reason")?.item.text).toBe("summary");
    expect(run.seen.find((e) => e.item?.id === "edit")?.item.changes[0].kind).toBe("update");
    expect(run.seen.find((e) => e.item?.id === "mcp")?.item.type).toBe("mcp_tool_call");
    expect(run.seen.some((e) => e.type === "provider.reconnecting")).toBe(true);
    expect(run.seen.at(-1)).toEqual({ type: "turn.completed", usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 5 } });
  });

  test("resumes native history and carries config and image inputs without injecting profile text", async () => {
    const f = setup({ workingDirectory: "/workspace", model: "test-model", sandboxMode: "workspace-write", approvalPolicy: "never", additionalDirectories: ["/shared"], webSearchMode: "disabled", modelReasoningEffort: "high", serviceTier: "priority" }, "thread-1", { config: { developer_instructions: "profile prompt", mcp_servers: { test: { command: "test-mcp" } } } });
    const run = await running(f, [{ type: "text", text: "image question" }, { type: "local_image", path: "/image.png" }]);
    expect(f.spawns[0].args.slice(0, 3)).toEqual(["app-server", "--listen", "stdio://"]);
    expect(f.spawns[0].args).toContain('developer_instructions="profile prompt"');
    expect(f.spawns[0].options.cwd).toBe("/workspace");
    expect(f.server.messages.find((m) => m.method === "thread/resume")?.params).toMatchObject({
      threadId: "thread-1", model: "test-model", sandbox: "workspace-write", approvalPolicy: "never", serviceTier: "priority",
      config: { web_search: "disabled", "sandbox_workspace_write.writable_roots": ["/shared"] },
    });
    expect(f.server.messages.find((m) => m.method === "turn/start")?.params).toEqual({
      threadId: "thread-1", effort: "high", input: [{ type: "text", text: "image question", text_elements: [] }, { type: "localImage", path: "/image.png" }],
    });
    expect(await f.thread.steer([{ type: "local_image", path: "/second.png" }])).toBe(true);
    expect(f.server.messages.find((m) => m.method === "turn/steer")?.params.input).toEqual([{ type: "localImage", path: "/second.png" }]);
    f.server.complete();
    await run.done;
  });

  test("delivers MCP stdio env and HTTP headers over thread RPC without exposing values in argv", async () => {
    const mcpServers = {
      local: { command: "fake-mcp", env: { MCP_KEY: "fake-stdio-canary" } },
      remote: { url: "http://127.0.0.1:1/mcp", http_headers: { "X-Api-Key": "fake-http-canary" } },
    };
    for (const resumeId of [undefined, "thread-1"]) {
      const f = setup({}, resumeId, { config: { mcp_servers: mcpServers, project_doc_max_bytes: 0 } });
      const run = await running(f);
      const argv = f.spawns[0].args.join(" ");
      expect(argv).not.toContain("fake-stdio-canary");
      expect(argv).not.toContain("fake-http-canary");
      expect(argv).not.toContain("mcp_servers");
      expect(argv).toContain("project_doc_max_bytes=0");
      const method = resumeId ? "thread/resume" : "thread/start";
      expect(f.server.messages.find((message) => message.method === method)?.params.config.mcp_servers).toEqual(mcpServers);
      f.server.complete();
      await run.done;
    }
  });

  test("refuses a mismatched native resume identity before sending input", async () => {
    const f = setup({}, "missing-thread");
    await expect(running(f)).rejects.toThrow("refusing context-free replacement");
    expect(f.server.messages.some((m) => m.method === "turn/start")).toBe(false);
  });

  test("uses ephemeral API-key authentication without changing persisted login", async () => {
    const f = setup({}, undefined, { apiKey: "test-only-key" });
    const run = await running(f);
    expect(f.spawns[0].args).toContain('cli_auth_credentials_store="ephemeral"');
    expect(f.spawns[0].args.join(" ")).not.toContain("test-only-key");
    expect(f.server.messages.map((m) => m.method).slice(0, 4)).toEqual(["initialize", "initialized", "account/login/start", "thread/start"]);
    expect(f.server.messages[2].params).toEqual({ type: "apiKey", apiKey: "test-only-key" });
    f.server.complete();
    await run.done;
  });

  test("reports failed turns and rejects streams that close without completion", async () => {
    const failed = setup();
    const run = await running(failed);
    failed.server.complete("failed");
    await run.done;
    expect(run.seen.at(-1)).toEqual({ type: "turn.failed", error: { message: "turn failed" } });
    const closed = setup();
    const closedRun = await running(closed);
    closed.server.close();
    await expect(closedRun.done).rejects.toThrow();
  });

  test("abort settles the turn and pending steering and is safe after teardown", async () => {
    const f = setup();
    f.server.hook = (message) => message.method === "turn/steer";
    const controller = new AbortController();
    const run = await running(f, "start", controller.signal);
    const delivery = f.thread.steer("pending");
    void delivery.catch(() => {});
    controller.abort();
    const checks = [expect(run.done).rejects.toMatchObject({ name: "AbortError" }), expect(delivery).rejects.toMatchObject({ name: "AbortError" })];
    await Promise.all(checks);
    expect(f.server.stdin.writableEnded).toBe(true);
    controller.abort();
    expect(() => f.server.stdin.emit("error", Object.assign(new Error("late"), { code: "EPIPE" }))).not.toThrow();
  });

  test("declines approval RPCs and rejects unsupported client requests", async () => {
    const f = setup();
    const run = await running(f);
    f.server.send({ id: "approval", method: "item/commandExecution/requestApproval", params: {} });
    f.server.send({ id: "unknown", method: "new/request", params: {} });
    await Bun.sleep(0);
    expect(f.server.messages.find((m) => m.id === "approval")).toEqual({ id: "approval", result: { decision: "decline" } });
    expect(f.server.messages.find((m) => m.id === "unknown")?.error.code).toBe(-32601);
    f.server.complete();
    await run.done;
  });
});
