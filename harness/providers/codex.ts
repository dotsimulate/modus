/**
 * Codex Provider — OpenAI Codex SDK execution backend.
 *
 * Handles: per-turn subprocess via Codex SDK, async event streaming,
 * thread resume for multi-turn, event translation to harness canonical format.
 *
 * Key difference from claude-code: Codex spawns a fresh subprocess per turn
 * (no long-lived process, no input channel). Multi-turn achieved via thread ID resume.
 */

import { Codex, type Thread, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";
import type { SessionProvider, TurnContext } from "./types";
import type { ActiveSession, MessageContent } from "../session-manager";
import { getMaxSeq, getSession, updateSessionStatus } from "../db";
import { logActivity } from "../activity";
import { resolveSecret } from "../secrets";

// ── Provider-specific state stored on session._providerState ──

type CodexState = {
  codex: Codex;
  thread: Thread | null;
  threadId: string | null;
  threadOptions: import("@openai/codex-sdk").ThreadOptions;
  abortController: AbortController;
};

function getState(session: ActiveSession): CodexState {
  return session._providerState as CodexState;
}

// ── Content → string input ──

function contentToString(content: MessageContent): string {
  if (typeof content === "string") return content;
  return (content as any[])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

// ── Event Translation ──

/** Build an assembled assistant event from an agent_message item */
function assembledAssistant(item: { text: string }) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: item.text }],
    },
  };
}

/** Build an assembled assistant event with thinking content */
function assembledThinking(item: { text: string }) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: item.text }],
    },
  };
}

/** Map a tool-like ThreadItem to a tool_use + tool_result pair */
function toolEvents(item: ThreadItem): any[] {
  const events: any[] = [];

  switch (item.type) {
    case "command_execution": {
      events.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: item.id,
            name: "Bash",
            input: { command: item.command },
          }],
        },
      });
      events.push({
        type: "user",
        subtype: "tool_result",
        isSynthetic: true,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: item.id,
            content: item.aggregated_output || `exit code: ${item.exit_code ?? "unknown"}`,
          }],
        },
      });
      break;
    }
    case "file_change": {
      const summary = item.changes
        .map(c => `${c.kind}: ${c.path}`)
        .join("\n");
      events.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: item.id,
            name: "Edit",
            input: { files: item.changes.map(c => c.path) },
          }],
        },
      });
      events.push({
        type: "user",
        subtype: "tool_result",
        isSynthetic: true,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: item.id,
            content: `${item.status}: ${summary}`,
          }],
        },
      });
      break;
    }
    case "mcp_tool_call": {
      events.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: item.id,
            name: `mcp__${item.server}__${item.tool}`,
            input: item.arguments ?? {},
          }],
        },
      });
      const resultText = item.error?.message
        ?? (item.result?.content?.map((c: any) => c.text ?? JSON.stringify(c)).join("\n"))
        ?? item.status;
      events.push({
        type: "user",
        subtype: "tool_result",
        isSynthetic: true,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: item.id,
            content: resultText,
          }],
        },
      });
      break;
    }
    case "web_search": {
      events.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: item.id,
            name: "WebSearch",
            input: { query: item.query },
          }],
        },
      });
      events.push({
        type: "user",
        subtype: "tool_result",
        isSynthetic: true,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: item.id,
            content: "Search completed",
          }],
        },
      });
      break;
    }
  }

  return events;
}

// ── Provider Implementation ──

export function createCodexProvider(): SessionProvider {
  return {
    startTurn(ctx: TurnContext) {
      const { session, opts, profile: profileDef } = ctx;

      // Resolve API key — Codex uses CODEX_API_KEY or OAuth
      const apiKey = resolveSecret("CODEX_API_KEY")
        ?? resolveSecret("OPENAI_API_KEY")
        ?? process.env.CODEX_API_KEY
        ?? process.env.OPENAI_API_KEY
        ?? undefined;

      const codex = new Codex({
        apiKey,
      });

      const threadOptions: import("@openai/codex-sdk").ThreadOptions = {
        model: opts.model ?? profileDef?.model ?? "gpt-5.1-codex",
        workingDirectory: opts.cwd ?? process.env.AGENT_CWD ?? process.cwd(),
        skipGitRepoCheck: true,
        sandboxMode: "danger-full-access",
      };

      // Map effort levels
      const effort = opts.effort ?? profileDef?.effort;
      if (effort) {
        const effortMap: Record<string, import("@openai/codex-sdk").ModelReasoningEffort> = {
          low: "low",
          medium: "medium",
          high: "high",
        };
        if (effort in effortMap) {
          threadOptions.modelReasoningEffort = effortMap[effort];
        }
      }

      // Check if this is a resume
      const isResume = !!opts.sessionId && !!getSession(opts.sessionId);

      const state: CodexState = {
        codex,
        thread: null,
        threadId: null,
        threadOptions,
        abortController: session.abortController,
      };
      session._providerState = state;

      // Start the turn
      const input = contentToString(session.initialContent);
      runTurn(ctx, state, input, isResume, false).catch((err) => {
        console.error(`[codex] startTurn error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
      });

      // Startup timeout
      const abortController = session.abortController;
      setTimeout(() => {
        if (session.status === "starting" && session.abortController === abortController) {
          const reason = "Session failed to start — no response from Codex within 30s.";
          console.error(`[codex] startup timeout for ${session.sessionId}`);
          session.status = "error";
          session.error = reason;
          abortController.abort();
          const errData = JSON.stringify({ type: "error", error: reason });
          for (const sub of session.subscribers) {
            try { sub.write("error", errData, String(session.seq)); } catch { /* ignore */ }
          }
        }
      }, 30_000);
    },

    sendMessage(ctx: TurnContext, content: MessageContent) {
      const { session } = ctx;
      const state = getState(session);

      if (session.status === "running" || session.status === "starting") {
        session.pendingMessages.push(content);
        return;
      }

      // Idle — start a new turn on the existing thread
      session.abortController = new AbortController();
      state.abortController = session.abortController;
      session.initialContent = content;
      session.preview = typeof content === "string" ? content.slice(0, 80) : "[content]";
      session.status = "running";
      session.turnStartedAt = Date.now();

      updateSessionStatus(session.sessionId, "running");

      const input = contentToString(content);
      runTurn(ctx, state, input, true, true).catch((err) => {
        console.error(`[codex] sendMessage error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
      });
    },

    abort(session: ActiveSession) {
      const state = getState(session);
      if (state) {
        state.abortController.abort();
      }
      session.abortController.abort();
    },

    updateConfig(session: ActiveSession, config: Record<string, any>) {
      const state = getState(session);
      if (!state) return;

      if (config.model !== undefined) {
        state.threadOptions.model = config.model || undefined;
      }
      if (config.effort !== undefined) {
        const effortMap: Record<string, import("@openai/codex-sdk").ModelReasoningEffort> = {
          low: "low",
          medium: "medium",
          high: "high",
        };
        state.threadOptions.modelReasoningEffort = config.effort in effortMap
          ? effortMap[config.effort]
          : undefined;
      }

      if (session.status === "running" || session.status === "starting") {
        session.abortController.abort();
      }
    },

    async dispose(session: ActiveSession) {
      const state = getState(session);
      if (!state) return;
      state.abortController.abort();
      session._providerState = null;
    },

    switchProfile(session: ActiveSession, ctx: TurnContext, contextMode: string) {
      const state = getState(session);
      if (!state) return;

      // Update thread options for next turn
      state.threadOptions.model = ctx.opts.model || undefined;
      const effort = ctx.opts.effort;
      if (effort) {
        const effortMap: Record<string, import("@openai/codex-sdk").ModelReasoningEffort> = {
          low: "low",
          medium: "medium",
          high: "high",
        };
        state.threadOptions.modelReasoningEffort = effort in effortMap
          ? effortMap[effort]
          : undefined;
      }
    },
  };
}

// ── Turn Execution ──

async function runTurn(
  ctx: TurnContext,
  state: CodexState,
  input: string,
  isResume: boolean,
  skipPromptPersist: boolean,
) {
  const { session } = ctx;

  // Start or resume thread
  let thread: Thread;
  if (state.threadId && isResume) {
    // Resume existing thread
    thread = state.codex.resumeThread(state.threadId, state.threadOptions);
  } else if (state.thread && isResume) {
    // Reuse thread object (same process, multi-turn)
    thread = state.thread;
  } else {
    // Fresh thread
    thread = state.codex.startThread(state.threadOptions);
  }
  state.thread = thread;

  // Run streamed
  const { events } = await thread.runStreamed(input, {
    signal: state.abortController.signal,
  });

  // Drain events
  let initEmitted = false;
  let turnTokens = { input: 0, cached: 0, output: 0 };
  let lastAgentText = "";
  let turnCount = 0;

  try {
    for await (const event of events) {
      if (state.abortController.signal.aborted) break;
      session.lastEventAt = Date.now();

      switch (event.type) {
        case "thread.started": {
          state.threadId = event.thread_id;

          // Emit init event — use thread_id as session ID for consistency
          if (!initEmitted) {
            initEmitted = true;
            const realId = event.thread_id;

            ctx.rekeySession(realId);
            session.status = "running";
            updateSessionStatus(realId, "running");

            if (isResume) {
              session.seq = getMaxSeq(realId);
            }

            // Emit user prompt
            if (!skipPromptPersist) {
              ctx.emitEvent({
                type: "user",
                subtype: "prompt",
                message: { role: "user", content: session.initialContent },
              });
            }

            // Emit system init
            ctx.emitEvent({
              type: "system",
              subtype: "init",
              session_id: realId,
              model: state.threadOptions.model ?? "gpt-5.1-codex",
              config: {
                provider: ctx.opts.provider ?? "codex",
                model: ctx.opts.model ?? state.threadOptions.model ?? "",
                effort: ctx.opts.effort ?? "",
                maxTurns: ctx.opts.maxTurns,
                toolStates: ctx.opts.toolStates ?? {},
              },
              cwd: session.cwd,
              loadProjectSettings: ctx.opts.loadProjectSettings ?? ctx.profile?.loadProjectSettings ?? false,
            });
          }
          break;
        }

        case "turn.started": {
          session.status = "running";
          turnCount++;
          break;
        }

        case "item.completed": {
          const item = event.item;

          switch (item.type) {
            case "agent_message": {
              lastAgentText = item.text;
              session.lastAssistantText = item.text.slice(-200);
              ctx.emitEvent(assembledAssistant(item));
              break;
            }
            case "reasoning": {
              ctx.emitEvent(assembledThinking(item));
              break;
            }
            case "command_execution":
            case "file_change":
            case "mcp_tool_call":
            case "web_search": {
              for (const ev of toolEvents(item)) {
                ctx.emitEvent(ev);
              }
              break;
            }
            case "todo_list": {
              // Informational — emit as system status
              ctx.broadcastEvent({
                type: "system",
                subtype: "status",
                status: "todo_update",
                items: item.items,
              });
              break;
            }
            case "error": {
              ctx.emitEvent({
                type: "system",
                subtype: "error",
                error: item.message,
              });
              break;
            }
          }
          break;
        }

        case "item.started":
        case "item.updated": {
          // Emit streaming updates for agent_message for live display
          if (event.item.type === "agent_message") {
            ctx.broadcastEvent({
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: event.item.text },
              },
              provider: "codex",
              // Full text so frontend can replace, not append
              fullText: event.item.text,
            });
          }
          break;
        }

        case "turn.completed": {
          turnTokens.input += event.usage.input_tokens;
          turnTokens.cached += event.usage.cached_input_tokens;
          turnTokens.output += event.usage.output_tokens;
          break;
        }

        case "turn.failed": {
          ctx.emitEvent({
            type: "result",
            subtype: "error",
            error: event.error.message,
            harness_duration_ms: Date.now() - session.turnStartedAt,
            input_tokens: turnTokens.input,
            output_tokens: turnTokens.output,
            total_tokens: turnTokens.input + turnTokens.output,
            num_turns: turnCount,
            total_cost_usd: 0,
          });

          session.status = "error";
          session.error = event.error.message;
          updateSessionStatus(session.sessionId, "error");
          return;
        }

        case "error": {
          ctx.emitEvent({
            type: "result",
            subtype: "error",
            error: event.message,
            harness_duration_ms: Date.now() - session.turnStartedAt,
            input_tokens: turnTokens.input,
            output_tokens: turnTokens.output,
            total_tokens: turnTokens.input + turnTokens.output,
            num_turns: turnCount,
            total_cost_usd: 0,
          });

          session.status = "error";
          session.error = event.message;
          updateSessionStatus(session.sessionId, "error");
          return;
        }
      }
    }

    // Stream completed successfully — emit result
    const durationMs = Date.now() - session.turnStartedAt;

    const resultEvent = {
      type: "result",
      subtype: "success",
      result: lastAgentText,
      harness_duration_ms: durationMs,
      input_tokens: turnTokens.input,
      output_tokens: turnTokens.output,
      total_tokens: turnTokens.input + turnTokens.output,
      num_turns: turnCount,
      total_cost_usd: 0, // Subscription-based, no per-token cost
    };

    ctx.emitEvent(resultEvent);

    session.costUsd += 0;
    session.numTurns += turnCount;

    ctx.updateSessionDb({
      status: "idle",
      messageCount: session.numTurns * 2,
      costUsd: 0,
      lastPrompt: session.preview,
      lastResponse: (lastAgentText || session.lastAssistantText || "").slice(0, 200),
    });

    logActivity({
      userProfile: session.userProfile,
      eventType: "session_end",
      sessionId: session.sessionId,
      agentProfile: session.profile,
      summary: `Turn completed: ${turnCount} turns, tokens: ${turnTokens.input}in/${turnTokens.output}out`,
      metadata: {
        numTurns: turnCount,
        status: "success",
        durationMs,
        inputTokens: turnTokens.input,
        outputTokens: turnTokens.output,
      },
    });

    session.status = "idle";

    // Flush queued messages
    if (session.pendingMessages.length > 0) {
      const next = session.pendingMessages.shift()!;
      session.initialContent = next;
      session.preview = typeof next === "string" ? next.slice(0, 80) : "[content]";
      session.abortController = new AbortController();
      state.abortController = session.abortController;
      session.status = "running";
      session.turnStartedAt = Date.now();

      const nextInput = contentToString(next);
      runTurn(ctx, state, nextInput, true, true).catch((err) => {
        console.error(`[codex] pending drain error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
      });
    }

  } catch (err: any) {
    if (session.status === "idle") return;

    console.error(`[codex] drain caught for ${session.sessionId}:`, err);
    const isAbort = err?.name === "AbortError" || err?.type === "abort"
      || String(err).includes("abort");

    if (isAbort) {
      console.log(`[codex] aborted ${session.sessionId}`);
      session.status = "idle";
      updateSessionStatus(session.sessionId, "idle");

      // Handle pending messages after abort
      if (session.pendingMessages.length > 0) {
        const next = session.pendingMessages.shift()!;
        session.initialContent = next;
        session.preview = typeof next === "string" ? next.slice(0, 80) : "[content]";
        session.abortController = new AbortController();
        state.abortController = session.abortController;
        session.status = "running";
        session.turnStartedAt = Date.now();

        const nextInput = contentToString(next);
        runTurn(ctx, state, nextInput, true, true).catch((err2) => {
          console.error(`[codex] post-abort drain error for ${session.sessionId}:`, err2);
          session.status = "error";
          session.error = String(err2);
          updateSessionStatus(session.sessionId, "error");
        });
      }
    } else {
      session.error = String(err);
      session.status = "error";
      updateSessionStatus(session.sessionId, "error");
      ctx.broadcastEvent({ type: "error", error: String(err) });
    }
  }
}
