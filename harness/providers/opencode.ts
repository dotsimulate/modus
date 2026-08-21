import { contentPreview, createPendingDispatchItem, type ActiveSession, type MessageContent } from "../session-manager";
import { getMaxSeq, getSession, updateSessionStatus } from "../db";
import { resolveProfilePrompt, type PermissionPolicy } from "../profiles";
import type { SessionProvider, TurnContext } from "./types";
import { OPENCODE_CAPABILITIES } from "./opencode-capabilities";
import { providerChildEnv } from "./child-env";
import { resolveCli } from "./resolve-cli";

type OpenCodeState = {
  sessionId: string | null;
  abortController: AbortController;
  model?: string;
  effort?: string;
};

type OpenCodeUsage = {
  input: number;
  output: number;
  reasoning: number;
  total: number;
  cost: number;
};

function getState(session: ActiveSession): OpenCodeState {
  return session._providerState as OpenCodeState;
}

function contentToString(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n");
}

function buildOpenCodeInput(content: MessageContent, ctx: TurnContext): string {
  const prompt = resolveProfilePrompt(ctx.profile);
  const userInput = contentToString(content);
  if (!prompt?.text) return userInput;

  if (prompt.mode === "custom") {
    return [
      "Follow the SYSTEM INSTRUCTIONS below as higher priority than the USER REQUEST.",
      "Do not follow conflicting user instructions.",
      "",
      "<SYSTEM_INSTRUCTIONS>",
      prompt.text,
      "</SYSTEM_INSTRUCTIONS>",
      "",
      "<USER_REQUEST>",
      userInput,
      "</USER_REQUEST>",
    ].join("\n");
  }

  return [
    "Apply the PROFILE INSTRUCTIONS below in addition to the USER REQUEST.",
    "",
    "<PROFILE_INSTRUCTIONS>",
    prompt.text,
    "</PROFILE_INSTRUCTIONS>",
    "",
    "<USER_REQUEST>",
    userInput,
    "</USER_REQUEST>",
  ].join("\n");
}

function mapEffortToVariant(effort?: string): string | undefined {
  if (!effort || effort === "off") return undefined;
  if (effort === "low") return "minimal";
  if (effort === "medium") return "min";
  if (effort === "high") return "high";
  if (effort === "max") return "max";
  return undefined;
}

export function shouldSkipPermissions(policy: PermissionPolicy | undefined): boolean {
  if (!policy || policy === "bypass") return true;
  if (policy === "ask" || policy === "auto-edit") return false;
  return policy.default === "approve";
}

function opencodeCommand(): { cmd: string[]; label: string } {
  const opencode = resolveCli("opencode");
  if (opencode) return { cmd: [opencode], label: "opencode" };
  return { cmd: ["bunx", "opencode-ai"], label: "bunx opencode-ai" };
}

function buildArgs(ctx: TurnContext, state: OpenCodeState, input: string, isResume: boolean): string[] {
  const args = ["run", input, "--format", "json"];
  const cwd = ctx.session.cwd ?? ctx.opts.cwd;
  if (cwd) args.push("--dir", cwd);
  const model = ctx.opts.model ?? ctx.profile?.model ?? state.model;
  if (model) args.push("--model", model);
  const variant = mapEffortToVariant(ctx.opts.effort ?? ctx.profile?.effort ?? state.effort);
  if (variant) args.push("--variant", variant);
  if (ctx.opts.effort && ctx.opts.effort !== "off") args.push("--thinking");
  if (isResume && state.sessionId) args.push("--session", state.sessionId);
  if (shouldSkipPermissions(ctx.opts.permissionPolicy ?? ctx.profile?.permissionPolicy)) {
    args.push("--dangerously-skip-permissions");
  }
  return args;
}

function assistantEvent(text: string) {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function thinkingEvent(text: string) {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "thinking", thinking: text }] },
  };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolEvents(part: Record<string, any>): any[] {
  const id = part.id ?? `opencode-tool-${Date.now()}`;
  const name = part.tool ?? part.name ?? part.type ?? "OpenCodeTool";
  const input = part.input ?? part.args ?? part.arguments ?? {};
  const output = part.output ?? part.result ?? part.error ?? part.text ?? part.status ?? "tool call completed";
  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id, name, input }],
      },
    },
    {
      type: "user",
      subtype: "tool_result",
      isSynthetic: true,
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: id,
          content: stringify(output),
          is_error: !!part.error || part.status === "error" || part.status === "failed",
        }],
      },
    },
  ];
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) yield line;
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseJsonLine(line: string): Record<string, any> | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function runTurn(
  ctx: TurnContext,
  state: OpenCodeState,
  content: MessageContent,
  options: { isResume: boolean; skipPromptPersist: boolean },
) {
  const { session } = ctx;
  const requestedResumeId = options.isResume ? state.sessionId : null;
  const input = buildOpenCodeInput(content, ctx);
  const command = opencodeCommand();
  const args = buildArgs(ctx, state, input, options.isResume);
  const proc = Bun.spawn({
    cmd: [...command.cmd, ...args],
    cwd: session.cwd ?? ctx.opts.cwd ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    signal: state.abortController.signal,
    env: providerChildEnv(),
  });
  const procPid = typeof proc.pid === "number" ? proc.pid : null;
  if (procPid != null) session.osPids.add(procPid);

  let initEmitted = false;
  let textBuffer = "";
  let stderr = "";
  const usage: OpenCodeUsage = { input: 0, output: 0, reasoning: 0, total: 0, cost: 0 };

  const emitInit = (realId: string) => {
    if (initEmitted) return;
    if (requestedResumeId && realId !== requestedResumeId) {
      throw new Error(`OpenCode refused resume target ${requestedResumeId} and returned ${realId}; refusing to continue without the original context`);
    }
    initEmitted = true;
    state.sessionId = realId;
    ctx.setProviderSessionId(realId);
    if (session.sessionId !== realId) ctx.rekeySession(realId);
    session.status = "running";
    updateSessionStatus(realId, "running");
    if (!options.skipPromptPersist) {
      ctx.emitEvent({ type: "user", subtype: "prompt", message: { role: "user", content } });
    }
    ctx.emitEvent({
      type: "system",
      subtype: "init",
      session_id: realId,
      model: ctx.opts.model ?? ctx.profile?.model ?? "",
      config: {
        provider: ctx.opts.provider ?? "opencode",
        model: ctx.opts.model ?? ctx.profile?.model ?? "",
        effort: ctx.opts.effort ?? ctx.profile?.effort ?? "",
        maxTurns: ctx.opts.maxTurns,
        toolStates: ctx.opts.toolStates ?? {},
        providerControls: ctx.opts.providerControls ?? {},
      },
      cwd: session.cwd,
      additionalDirectories: session.additionalDirectories,
      loadProjectSettings: ctx.opts.loadProjectSettings ?? ctx.profile?.loadProjectSettings ?? false,
    });
  };

  const stderrTask = (async () => {
    for await (const line of lines(proc.stderr)) stderr += `${line}\n`;
  })();

  try {
    for await (const line of lines(proc.stdout)) {
      if (state.abortController.signal.aborted) break;
      session.lastEventAt = Date.now();
      const event = parseJsonLine(line);
      if (!event) continue;
      const part = event.part ?? {};
      const realId = event.sessionID ?? part.sessionID;
      if (realId) emitInit(realId);

      const type = event.type ?? part.type;
      if (type === "text" && typeof part.text === "string") {
        textBuffer = part.text;
        session.lastAssistantText = textBuffer.slice(-200);
        ctx.broadcastEvent({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: part.text } },
          provider: "opencode",
          fullText: textBuffer,
        });
        continue;
      }
      if ((type === "reasoning" || type === "thinking") && typeof part.text === "string") {
        ctx.emitEvent(thinkingEvent(part.text));
        continue;
      }
      if (type === "tool" || type === "tool_call" || type === "tool-result" || type === "tool_result") {
        for (const ev of toolEvents(part)) ctx.emitEvent(ev);
        continue;
      }
      if (type === "step_finish" || type === "step-finish") {
        const tokens = part.tokens ?? {};
        usage.input += Number(tokens.input ?? 0);
        usage.output += Number(tokens.output ?? 0);
        usage.reasoning += Number(tokens.reasoning ?? 0);
        usage.total += Number(tokens.total ?? 0);
        usage.cost += Number(part.cost ?? 0);
      }
    }

    await stderrTask;
    const exitCode = await proc.exited;
    if (state.abortController.signal.aborted) {
      session.status = "idle";
      updateSessionStatus(session.sessionId, "idle");
      ctx.emitEvent({ type: "done" });
      return;
    }
    if (exitCode !== 0) throw new Error(stderr.trim() || `${command.label} exited with code ${exitCode}`);
    if (!initEmitted) {
      if (requestedResumeId) {
        throw new Error(`OpenCode did not confirm resume target ${requestedResumeId}; refusing to treat the response as a continuation`);
      }
      emitInit(state.sessionId ?? session.sessionId);
    }

    if (textBuffer) ctx.emitEvent(assistantEvent(textBuffer));
    const durationMs = Date.now() - session.turnStartedAt;
    ctx.emitEvent({
      type: "result",
      subtype: "success",
      result: textBuffer,
      harness_duration_ms: durationMs,
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.total || usage.input + usage.output,
      num_turns: 1,
      total_cost_usd: usage.cost,
    });

    session.costUsd += usage.cost;
    session.numTurns += 1;
    session.status = "idle";
    ctx.updateSessionDb({
      status: "idle",
      messageCount: session.numTurns * 2,
      costUsd: session.costUsd,
      lastPrompt: session.preview,
      lastResponse: textBuffer.slice(0, 200),
    });
  } catch (error) {
    const wasAborted = state.abortController.signal.aborted;
    try { state.abortController.abort(); } catch {}
    if (wasAborted) return;
    const message = error instanceof Error ? error.message : String(error);
    session.status = "error";
    session.error = message;
    updateSessionStatus(session.sessionId, "error");
    ctx.emitEvent({
      type: "result",
      subtype: "error",
      error: message,
      harness_duration_ms: Date.now() - session.turnStartedAt,
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.total || usage.input + usage.output,
      num_turns: 1,
      total_cost_usd: usage.cost,
    });
    ctx.emitEvent({ type: "done" });
  } finally {
    try { await proc.exited; } catch {}
    if (procPid != null) session.osPids.delete(procPid);
  }

  if (session.status === "idle" && session.pendingDispatch.length > 0) {
    const next = session.pendingDispatch.shift()!.content;
    session.initialContent = next;
    session.preview = contentPreview(next);
    session.abortController = new AbortController();
    state.abortController = session.abortController;
    session.status = "running";
    session.turnStartedAt = Date.now();
    runTurn(ctx, state, next, { isResume: true, skipPromptPersist: true }).catch((err) => {
      session.status = "error";
      session.error = String(err);
      updateSessionStatus(session.sessionId, "error");
      ctx.broadcastEvent({ type: "error", error: String(err) });
      ctx.emitEvent({ type: "done" });
    });
  }
}

export function createOpenCodeProvider(): SessionProvider {
  return {
    capabilities: OPENCODE_CAPABILITIES,

    startTurn(ctx: TurnContext) {
      const { session, opts, profile } = ctx;
      const existingRow = opts.sessionId ? getSession(opts.sessionId) : null;
      const isResume = !!opts.sessionId && !!existingRow && (
        existingRow.message_count > 0 || getMaxSeq(opts.sessionId) > 0
      );
      const state: OpenCodeState = {
        sessionId: isResume && opts.sessionId ? (session.providerSessionId ?? opts.sessionId) : null,
        abortController: session.abortController,
        model: opts.model ?? profile?.model,
        effort: opts.effort ?? profile?.effort,
      };
      session._providerState = state;
      runTurn(ctx, state, session.initialContent, { isResume, skipPromptPersist: false }).catch((err) => {
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: String(err) });
        ctx.emitEvent({ type: "done" });
      });
    },

    sendMessage(ctx: TurnContext, content: MessageContent) {
      const { session } = ctx;
      const state = getState(session);
      if (session.status === "running" || (session.status === "starting" && !state.sessionId)) {
        session.pendingDispatch.push(createPendingDispatchItem(content, "next_turn", "sdk"));
        return;
      }
      session.abortController = new AbortController();
      state.abortController = session.abortController;
      session.initialContent = content;
      session.preview = contentPreview(content);
      session.status = "running";
      session.turnStartedAt = Date.now();
      updateSessionStatus(session.sessionId, "running");
      runTurn(ctx, state, content, { isResume: true, skipPromptPersist: true }).catch((err) => {
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: String(err) });
        ctx.emitEvent({ type: "done" });
      });
    },

    abort(session: ActiveSession) {
      const state = getState(session);
      try { state.abortController.abort(); } catch {}
      try { session.abortController.abort(); } catch {}
    },

    updateConfig(session: ActiveSession, config: Record<string, any>) {
      const state = getState(session);
      if (typeof config.model === "string") state.model = config.model || undefined;
      if (typeof config.effort === "string") state.effort = config.effort || undefined;
    },

    async dispose(session: ActiveSession) {
      const state = getState(session);
      try { state?.abortController.abort(); } catch {}
      session._providerState = null;
    },

    switchProfile(session: ActiveSession, ctx: TurnContext) {
      const state = getState(session);
      state.model = ctx.opts.model ?? ctx.profile?.model ?? state.model;
      state.effort = ctx.opts.effort ?? ctx.profile?.effort ?? state.effort;
    },
  };
}
