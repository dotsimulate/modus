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
import type { ProviderCapabilities, SessionProvider, TurnContext } from "./types";
import type { ActiveSession, MessageContent } from "../session-manager";
import { getMaxSeq, getSession, updateSessionStatus } from "../db";
import { logActivity } from "../activity";
import { resolveSecret } from "../secrets";
import {
  getGlobalConfig, getProfile, getUserProfile, resolveProfilePrompt,
  type McpServerConfig, type PermissionPolicy, type Profile,
} from "../profiles";
import { isAbsolute, join } from "path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";

// ── Provider-specific state stored on session._providerState ──

type CodexState = {
  codex: Codex;
  thread: Thread | null;
  threadId: string | null;
  threadOptions: import("@openai/codex-sdk").ThreadOptions;
  abortController: AbortController;
  rulesFilePath?: string;
};

type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
type CodexConfigObject = {
  [key: string]: CodexConfigValue;
};

const CODEX_CAPABILITIES: ProviderCapabilities = {
  name: "codex",
  label: "Codex",
  family: "codex",
  builtInTools: ["Bash", "Write", "Edit", "WebSearch"],
  builtInToolGroups: [
    { label: "exec", tools: ["Bash"] },
    { label: "files", tools: ["Write", "Edit"] },
    { label: "web", tools: ["WebSearch"] },
  ],
  builtInToolMode: "event-derived",
  supportsMcp: true,
  mcpSupport: "full",
  nonToolSignals: ["reasoning", "todo_list", "file_change"],
  permissionModel: {
    mode: "runtime-native",
    interactive: false,
    summary: "Codex exec mode supports sandbox and approval settings, but this harness path cannot surface live per-tool approve or deny prompts.",
  },
  sessionMutability: {
    providerSwitchAfterStart: false,
    profileSwitch: "provider-locked",
    configApplies: "next-turn",
  },
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

function buildCodexInput(content: MessageContent, ctx: TurnContext): string {
  const prompt = resolveProfilePrompt(ctx.profile);
  const userInput = contentToString(content);
  if (!prompt?.text) return userInput;

  // Codex SDK does not expose a first-class system prompt or provider preset API.
  // For now both prompt modes are applied as an injected instruction prelude so
  // Codex sessions actually honor the profile contract instead of ignoring it.
  const header = prompt.mode === "custom"
    ? "System instructions:"
    : "Additional profile instructions:";

  return `${header}\n${prompt.text}\n\nUser request:\n${userInput}`;
}

function resolveMcpEnv(env: Record<string, string> | undefined, serverName: string): Record<string, string> | undefined {
  if (!env) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, val] of Object.entries(env)) {
    if (val.startsWith("$")) {
      const envVal = resolveSecret(val.slice(1));
      if (envVal !== undefined) {
        resolved[key] = envVal;
      } else {
        console.warn(`[codex] Missing secret ${val} for MCP server "${serverName}"`);
      }
    } else {
      resolved[key] = val;
    }
  }
  return resolved;
}

function buildCodexEnv(extraEnv: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  return { ...merged, ...extraEnv };
}

function codexBearerEnvName(serverName: string): string {
  return `CODEX_MCP_BEARER_${serverName.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

function buildRemoteCodexMcpServer(
  name: string,
  config: Extract<McpServerConfig, { type: "http" | "sse" }>,
  env: Record<string, string>,
): CodexConfigObject | null {
  if (config.type === "sse") {
    console.warn(`[codex] Skipping MCP server "${name}" — Codex MCP wiring expects streamable HTTP, not SSE.`);
    return null;
  }

  const serverConfig: CodexConfigObject = {
    url: config.url,
  };

  const authHeader = Object.entries(config.headers ?? {}).find(
    ([key, value]) => key.toLowerCase() === "authorization" && /^Bearer\s+/i.test(value),
  );
  if (authHeader) {
    const envName = codexBearerEnvName(name);
    env[envName] = authHeader[1].replace(/^Bearer\s+/i, "");
    serverConfig.bearer_token_env_var = envName;
  }

  const unsupportedHeaders = Object.keys(config.headers ?? {}).filter(
    (key) => key.toLowerCase() !== "authorization",
  );
  if (unsupportedHeaders.length > 0) {
    console.warn(
      `[codex] MCP server "${name}" has unsupported HTTP headers for Codex CLI and they will be ignored: ${unsupportedHeaders.join(", ")}`,
    );
  }

  return serverConfig;
}

// ── Codex Rules File (.rules) ──

/**
 * Write profile codexRules to ~/.codex/rules/harness-{sessionId}.rules.
 * Format: Starlark prefix_rule() calls, one per line.
 * Example rule: prefix_rule(pattern=["rm"], decision="forbidden")
 * Rules in this directory merge alphabetically; harness- prefix scopes them to us.
 */
function writeCodexRulesFile(rules: string[], sessionId: string): string | undefined {
  if (!rules.length) return undefined;
  const rulesDir = join(homedir(), ".codex", "rules");
  try {
    mkdirSync(rulesDir, { recursive: true });
    const filePath = join(rulesDir, `harness-${sessionId}.rules`);
    writeFileSync(filePath, rules.join("\n") + "\n", "utf8");
    console.log(`[codex] wrote rules file: ${filePath} (${rules.length} rules)`);
    return filePath;
  } catch (err) {
    console.warn(`[codex] Failed to write rules file for session ${sessionId}:`, err);
    return undefined;
  }
}

function cleanupCodexRulesFile(filePath: string | undefined): void {
  if (!filePath) return;
  try {
    unlinkSync(filePath);
  } catch {
    // Ignore — file may already be gone on cleanup
  }
}

// ── Permission Policy → Codex sandbox/approval mapping ──

/**
 * Maps harness PermissionPolicy to Codex-native controls.
 *
 * Codex exec mode does NOT support interactive approvals. Research confirmed:
 * - Approval requests are never emitted as JSONL events — no interception possible.
 * - exec mode auto-rejects all approval-requiring operations regardless of approvalPolicy flag.
 * - The delegate/callback approval system exists in the Rust library, not in exec mode.
 *
 * Practical mapping:
 *   "bypass"  → approvalPolicy "never", sandboxMode "danger-full-access"
 *   "ask"     → approvalPolicy "never", sandboxMode "workspace-write" (physical containment)
 *                warns that interactive approval is not achievable
 *   object    → maps only the `default` field; requireApproval lists warn and are ignored
 *                use profile.codexRules for command-level allow/forbidden enforcement
 *
 * codexSandboxMode on the profile overrides the derived sandboxMode.
 */
function mapPermissionPolicy(
  policy: PermissionPolicy | undefined,
  codexSandboxMode?: "read-only" | "workspace-write" | "danger-full-access",
): {
  approvalPolicy: import("@openai/codex-sdk").ApprovalMode;
  sandboxMode: import("@openai/codex-sdk").SandboxMode;
} {
  let approvalPolicy: import("@openai/codex-sdk").ApprovalMode = "never";
  let sandboxMode: import("@openai/codex-sdk").SandboxMode = "danger-full-access";

  if (!policy || policy === "bypass") {
    approvalPolicy = "never";
    sandboxMode = "danger-full-access";
  } else if (policy === "ask") {
    console.warn(
      "[codex] permissionPolicy \"ask\" cannot be honored — Codex exec mode auto-rejects " +
      "interactive approvals. Falling back to sandboxMode \"workspace-write\" with no approval " +
      "prompts. Use codexRules in the profile for command-level allow/forbidden enforcement.",
    );
    approvalPolicy = "never";
    sandboxMode = "workspace-write";
  } else {
    // Object policy
    if (policy.requireApproval?.length) {
      console.warn(
        `[codex] permissionPolicy.requireApproval [${policy.requireApproval.join(", ")}] ` +
        "cannot be honored — Codex exec mode has no per-tool approval hooks. " +
        "Use codexRules in the profile for command-level allow/forbidden enforcement.",
      );
    }
    approvalPolicy = "never";
    sandboxMode = policy.default === "ask" ? "workspace-write" : "danger-full-access";
  }

  // codexSandboxMode on the profile overrides the derived value
  if (codexSandboxMode) sandboxMode = codexSandboxMode;

  return { approvalPolicy, sandboxMode };
}

type CodexProviderControls = {
  sandboxMode?: import("@openai/codex-sdk").SandboxMode;
  webSearchMode?: import("@openai/codex-sdk").WebSearchMode;
};

function readCodexProviderControls(raw: unknown): CodexProviderControls {
  if (!raw || typeof raw !== "object") return {};
  const codex = (raw as Record<string, unknown>).codex;
  if (!codex || typeof codex !== "object") return {};

  const controls: CodexProviderControls = {};
  if (
    (codex as Record<string, unknown>).sandboxMode === "read-only"
    || (codex as Record<string, unknown>).sandboxMode === "workspace-write"
    || (codex as Record<string, unknown>).sandboxMode === "danger-full-access"
  ) {
    controls.sandboxMode = (codex as Record<string, import("@openai/codex-sdk").SandboxMode>).sandboxMode;
  }
  if (
    (codex as Record<string, unknown>).webSearchMode === "disabled"
    || (codex as Record<string, unknown>).webSearchMode === "cached"
    || (codex as Record<string, unknown>).webSearchMode === "live"
  ) {
    controls.webSearchMode = (codex as Record<string, import("@openai/codex-sdk").WebSearchMode>).webSearchMode;
  }
  return controls;
}

function isLegacyToolEnabled(
  tool: "Bash" | "Edit" | "WebSearch",
  profileTools: string[] | undefined,
  toolStates: Record<string, string> | undefined,
): boolean {
  const state = toolStates?.[tool];
  if (state === "on") return true;
  if (state === "off") return false;
  return !profileTools || profileTools.includes(tool);
}

function resolveCodexRuntimeSettings(
  profileDef: Profile | undefined,
  opts: {
    toolStates?: Record<string, string>;
    providerControls?: Record<string, unknown>;
  },
): {
  approvalPolicy: import("@openai/codex-sdk").ApprovalMode;
  sandboxMode: import("@openai/codex-sdk").SandboxMode;
  webSearchMode: import("@openai/codex-sdk").WebSearchMode;
} {
  const controls = readCodexProviderControls(opts.providerControls);
  const { approvalPolicy, sandboxMode: derivedSandbox } = mapPermissionPolicy(
    profileDef?.permissionPolicy,
    profileDef?.codexSandboxMode,
  );

  let sandboxMode = controls.sandboxMode ?? derivedSandbox;
  if (!controls.sandboxMode) {
    const bashEnabled = isLegacyToolEnabled("Bash", profileDef?.tools, opts.toolStates);
    const editEnabled = isLegacyToolEnabled("Edit", profileDef?.tools, opts.toolStates);
    // Legacy tool toggles cannot express shell/files independently in Codex.
    // Approximate "one disabled" as workspace-write and "both disabled" as read-only.
    if (!bashEnabled && !editEnabled) {
      sandboxMode = "read-only";
    } else if (!bashEnabled || !editEnabled) {
      sandboxMode = "workspace-write";
    }
  }

  let webSearchMode = controls.webSearchMode;
  if (!webSearchMode) {
    webSearchMode = isLegacyToolEnabled("WebSearch", profileDef?.tools, opts.toolStates)
      ? "live"
      : "disabled";
  }

  return { approvalPolicy, sandboxMode, webSearchMode };
}

function buildCodexConfig(ctx: TurnContext): { config?: CodexConfigObject; env?: Record<string, string> } {
  const { opts, profile } = ctx;
  const globalConfig = getGlobalConfig(ctx.session.cwd);
  const mergedMcp = {
    ...(globalConfig.mcpServers ?? {}),
    ...(profile?.mcpServers ?? {}),
  };
  if (Object.keys(mergedMcp).length === 0) return {};

  // Resolve relative --directory args to absolute (same as claude-code provider)
  const harnessRoot = join(import.meta.dir, "..");
  for (const server of Object.values(mergedMcp) as any[]) {
    const args = server.args as string[] | undefined;
    if (!args) continue;
    const dirIdx = args.indexOf("--directory");
    const dirVal = dirIdx >= 0 ? args[dirIdx + 1] : undefined;
    if (dirVal && !isAbsolute(dirVal)) {
      args[dirIdx + 1] = join(harnessRoot, dirVal);
    }
  }

  // Inject agent-memory scoping env vars (mirrors claude-code provider)
  if (mergedMcp["agent-memory"]) {
    const am = mergedMcp["agent-memory"] as any;
    const env: Record<string, string> = { ...(am.env ?? {}) };
    if (opts.profile) env.AGENT_PROFILE = opts.profile;
    if (opts.userProfile) env.USER_PROFILE = opts.userProfile;

    const sessionCwd = opts.cwd ?? process.env.AGENT_CWD;
    if (sessionCwd) {
      const projectMemoryDir = join(sessionCwd, ".modus", "memory");
      if (existsSync(projectMemoryDir)) {
        env.AGENT_MEMORY_DIR = projectMemoryDir;
        const dirIdx = (am.args as string[] | undefined)?.indexOf("--directory");
        const agentMemoryRoot = dirIdx !== undefined && dirIdx >= 0 ? (am.args as string[])[dirIdx + 1] : undefined;
        if (agentMemoryRoot) {
          env.AGENT_MEMORY_READ_DIRS = `${agentMemoryRoot}/memory`;
        }
      }
    }

    if (opts.userProfile) {
      const userProf = getUserProfile(opts.userProfile);
      if (userProf?.projects?.length) {
        env.AGENT_MEMORY_SKILLS_DIRS = userProf.projects
          .map(p => join(p, ".claude", "skills"))
          .join(",");
      } else {
        env.AGENT_MEMORY_SKILLS_DIRS = "";
      }
      if (userProf?.memory?.scope === "profile") {
        const dirIdx = (am.args as string[] | undefined)?.indexOf("--directory");
        const agentMemoryRoot = dirIdx !== undefined && dirIdx >= 0 ? (am.args as string[])[dirIdx + 1] : undefined;
        if (agentMemoryRoot) {
          const globalDir = `${agentMemoryRoot}/memory`;
          const profileDir = `${agentMemoryRoot}/memory/profiles/${opts.userProfile}`;
          env.AGENT_MEMORY_DIR = profileDir;
          if (userProf.memory.inheritGlobal !== false) {
            env.AGENT_MEMORY_READ_DIRS = globalDir;
          }
        }
      }
    }
    am.env = env;
  }

  const mcpServers: CodexConfigObject = {};
  const extraEnv: Record<string, string> = {};
  for (const [name, config] of Object.entries(mergedMcp)) {
    if ("command" in config) {
      const serverConfig: CodexConfigObject = {
        command: config.command,
      };
      if (config.args?.length) serverConfig.args = config.args;
      const env = resolveMcpEnv(config.env, name);
      if (env && Object.keys(env).length > 0) serverConfig.env = env;
      mcpServers[name] = serverConfig;
      continue;
    }

    const remoteConfig = buildRemoteCodexMcpServer(name, config, extraEnv);
    if (remoteConfig) mcpServers[name] = remoteConfig;
  }

  return {
    config: Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : undefined,
    env: Object.keys(extraEnv).length > 0 ? buildCodexEnv(extraEnv) : undefined,
  };
}

function createCodexClient(ctx: TurnContext, apiKey: string | undefined): Codex {
  const { config, env } = buildCodexConfig(ctx);
  return new Codex({
    apiKey,
    config,
    env,
  });
}

function resolveCodexApiKey(): string | undefined {
  return resolveSecret("CODEX_API_KEY")
    ?? resolveSecret("OPENAI_API_KEY")
    ?? process.env.CODEX_API_KEY
    ?? process.env.OPENAI_API_KEY
    ?? undefined;
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
      const commandFailed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
      events.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: item.id,
            name: "CommandExecution",
            input: {
              command: item.command,
              status: item.status,
              ...(item.exit_code != null ? { exit_code: item.exit_code } : {}),
            },
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
            is_error: commandFailed,
          }],
        },
      });
      break;
    }
    case "file_change": {
      const patchFailed = item.status === "failed";
      for (const change of item.changes) {
        const toolId = `${item.id}_${change.path.replace(/\W/g, "_")}`;
        events.push({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: toolId,
              name: "FileChange",
              input: {
                file_path: change.path,
                change_kind: change.kind,
                status: item.status,
              },
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
              tool_use_id: toolId,
              content: `${change.kind}: ${change.path} (${item.status})`,
              is_error: patchFailed,
            }],
          },
        });
      }
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
            name: "MCPToolCall",
            input: {
              server: item.server,
              tool: item.tool,
              arguments: item.arguments ?? {},
              status: item.status,
            },
          }],
        },
      });
      const resultText = item.error?.message
        ?? (item.result?.content?.map((c: any) => c.text ?? JSON.stringify(c)).join("\n"))
        ?? item.status;
      const mcpFailed = item.status === "failed" || !!item.error;
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
            is_error: mcpFailed,
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
            content: "search completed",
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
    capabilities: CODEX_CAPABILITIES,
    startTurn(ctx: TurnContext) {
      const { session, opts, profile: profileDef } = ctx;

      // Resolve API key — Codex uses CODEX_API_KEY or OAuth
      const apiKey = resolveCodexApiKey();
      const codex = createCodexClient(ctx, apiKey);

      const { approvalPolicy, sandboxMode, webSearchMode } = resolveCodexRuntimeSettings(profileDef, {
        toolStates: opts.toolStates,
        providerControls: opts.providerControls,
      });
      const threadOptions: import("@openai/codex-sdk").ThreadOptions = {
        model: opts.model ?? profileDef?.model ?? "gpt-5.1-codex",
        workingDirectory: opts.cwd ?? process.env.AGENT_CWD ?? process.cwd(),
        skipGitRepoCheck: true,
        sandboxMode,
        approvalPolicy,
        webSearchMode,
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

      // On resume, session ID IS the Codex thread ID (set by rekeySession on first turn)
      const state: CodexState = {
        codex,
        thread: null,
        threadId: isResume && opts.sessionId ? opts.sessionId : null,
        threadOptions,
        abortController: session.abortController,
      };
      session._providerState = state;

      // Write codexRules file if profile specifies any
      if (profileDef?.codexRules?.length) {
        state.rulesFilePath = writeCodexRulesFile(profileDef.codexRules, session.sessionId);
      }

      // Start the turn
      const input = buildCodexInput(session.initialContent, ctx);
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

      // Rebuild the Codex client so next turns pick up live MCP/profile changes.
      state.codex = createCodexClient(ctx, resolveCodexApiKey());

      const input = buildCodexInput(content, ctx);
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

      const profileDef = session.profile ? getProfile(session.profile, session.cwd) : undefined;
      const runtime = resolveCodexRuntimeSettings(profileDef, {
        toolStates: session._configOverrides.toolStates,
        providerControls: session._configOverrides.providerControls,
      });
      state.threadOptions.approvalPolicy = runtime.approvalPolicy;
      state.threadOptions.sandboxMode = runtime.sandboxMode;
      state.threadOptions.webSearchMode = runtime.webSearchMode;

      if (session.status === "running" || session.status === "starting") {
        session.abortController.abort();
      }
    },

    async dispose(session: ActiveSession) {
      const state = getState(session);
      if (!state) return;
      state.abortController.abort();
      cleanupCodexRulesFile(state.rulesFilePath);
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
      // Update permission policy for next turn
      const runtime = resolveCodexRuntimeSettings(ctx.profile, {
        toolStates: ctx.opts.toolStates,
        providerControls: ctx.opts.providerControls,
      });
      state.threadOptions.approvalPolicy = runtime.approvalPolicy;
      state.threadOptions.sandboxMode = runtime.sandboxMode;
      state.threadOptions.webSearchMode = runtime.webSearchMode;

      state.codex = createCodexClient(ctx, resolveCodexApiKey());
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
                providerControls: ctx.opts.providerControls ?? {},
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
              const todos = item.items.map((it, idx) => ({
                content: it.text,
                status: it.completed ? "completed" : "pending",
                order: idx,
              }));
              ctx.emitEvent({
                type: "assistant",
                message: {
                  role: "assistant",
                  content: [{
                    type: "tool_use",
                    id: item.id,
                    name: "TodoWrite",
                    input: { todos },
                  }],
                },
              });
              ctx.emitEvent({
                type: "user",
                subtype: "tool_result",
                isSynthetic: true,
                message: {
                  role: "user",
                  content: [{
                    type: "tool_result",
                    tool_use_id: item.id,
                    content: "todo list updated",
                  }],
                },
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

      const nextInput = buildCodexInput(next, ctx);
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

        const nextInput = buildCodexInput(next, ctx);
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
