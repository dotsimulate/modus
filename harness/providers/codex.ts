/**
 * Codex Provider — external Codex CLI execution backend.
 *
 * Handles: per-turn subprocess via Codex CLI, async event streaming,
 * thread resume for multi-turn, event translation to harness canonical format.
 *
 * Key difference from claude-code: Codex spawns a fresh subprocess per turn
 * (no long-lived process, no input channel). Multi-turn achieved via thread ID resume.
 */

import { canResumeCodexThread, Codex, Thread } from "./codex-cli-sdk";
import type { ApprovalMode, ModelReasoningEffort, SandboxMode, ServiceTier, ThreadEvent, ThreadItem, ThreadOptions, WebSearchMode } from "./codex-cli-sdk";
import type { ProviderCapabilities, SessionProvider, TurnContext } from "./types";
import { createPendingDispatchItem, type ActiveSession, type MessageContent } from "../session-manager";
import { getMaxSeq, getSession, updateSessionStatus } from "../db";
import { logActivity } from "../activity";
import { getCodexSeedModel } from "./codex-model-cache";
import { resolveSecret } from "../secrets";
import {
  getGlobalConfig, getProfile, resolveProfilePrompt,
  type McpServerConfig, type PermissionPolicy, type Profile,
} from "../profiles";
import { dirname, isAbsolute, join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";

// ── Provider-specific state stored on session._providerState ──

type CodexState = {
  codex: Codex;
  thread: Thread | null;
  threadId: string | null;
  threadOptions: ThreadOptions;
  abortController: AbortController;
  rulesFilePath?: string;
  goal?: CodexGoalState;
};

type CodexGoalStatus = "active" | "paused" | "complete" | "blocked";

type CodexGoalState = {
  objective: string;
  status: CodexGoalStatus;
  iterations: number;
  startedAt: number;
  updatedAt: number;
  lastStatus?: string;
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
  slashCommands: [
    {
      command: "/goal",
      label: "/goal",
      argumentHint: "<objective>",
      requiresArgument: true,
      source: "modus",
      description: "Start a Modus-managed Codex goal loop for this session.",
    },
    {
      command: "/goal",
      label: "/goal status",
      source: "modus",
      description: "Show the current Codex goal status.",
    },
    {
      command: "/goal pause",
      label: "/goal pause",
      source: "modus",
      description: "Pause the active Codex goal loop.",
    },
    {
      command: "/goal resume",
      label: "/goal resume",
      source: "modus",
      description: "Resume a paused or blocked Codex goal loop.",
    },
    {
      command: "/goal clear",
      label: "/goal clear",
      source: "modus",
      description: "Clear the Codex goal for this session.",
    },
  ],
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

function mapCodexReasoningEffort(
  effort?: string,
): ModelReasoningEffort | undefined {
  if (!effort || effort === "off" || effort === "max") return undefined;
  const effortMap: Record<string, ModelReasoningEffort> = {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  };
  return effortMap[effort];
}

// ── Content → string input ──

function contentToString(content: MessageContent): string {
  if (typeof content === "string") return content;
  return (content as any[])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

type GoalCommand =
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "set"; objective: string };

function parseGoalCommand(content: MessageContent): GoalCommand | null {
  const text = contentToString(content).trim();
  const match = text.match(/^\/goal(?::|\s+)?([\s\S]*)$/i);
  if (!match) return null;

  const arg = (match[1] ?? "").trim();
  if (!arg) return { kind: "status" };

  const lower = arg.toLowerCase();
  if (lower === "pause") return { kind: "pause" };
  if (lower === "resume") return { kind: "resume" };
  if (lower === "clear") return { kind: "clear" };
  return { kind: "set", objective: arg };
}

function goalStatusLine(goal: CodexGoalState | undefined): string {
  if (!goal) return "No active Codex goal is set for this Modus session.";
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - goal.startedAt) / 1000));
  const checkpoint = goal.lastStatus ? `\nLast status: ${goal.lastStatus}` : "";
  return `Goal ${goal.status}: ${goal.objective}\nTurns: ${goal.iterations}\nElapsed: ${elapsedSeconds}s${checkpoint}`;
}

function buildGoalPrompt(objective: string): string {
  return [
    "Modus Codex goal mode is active.",
    "",
    "Objective:",
    objective,
    "",
    "Keep working in concrete checkpoints until the objective is met, blocked, or the user pauses or clears the goal.",
    "Validate progress with the repo's normal checks when possible. Do not stop after a partial checkpoint if meaningful work remains.",
    "If native Codex goal tools are available, use them according to their descriptions; Modus still requires the markers below for its chat-side continuation loop.",
    "",
    "At the end of every response, include exactly one marker on its own line:",
    "GOAL_CONTINUE: <next checkpoint>",
    "GOAL_COMPLETE: <evidence that the objective is done>",
    "GOAL_BLOCKED: <specific blocker and what the user must decide or provide>",
  ].join("\n");
}

function buildGoalContinuationPrompt(goal: CodexGoalState): string {
  return [
    "Continue the active Modus Codex goal.",
    "",
    "Objective:",
    goal.objective,
    "",
    goal.lastStatus ? `Previous checkpoint: ${goal.lastStatus}` : "Previous checkpoint: continue from the current repository and conversation state.",
    "",
    "If native Codex goal tools are available, use them according to their descriptions.",
    "Keep making scoped progress. End with exactly one marker on its own line:",
    "GOAL_CONTINUE: <next checkpoint>",
    "GOAL_COMPLETE: <evidence that the objective is done>",
    "GOAL_BLOCKED: <specific blocker and what the user must decide or provide>",
  ].join("\n");
}

function updateGoalFromAssistant(goal: CodexGoalState | undefined, text: string): boolean {
  if (!goal || goal.status !== "active") return false;

  const complete = text.match(/^\s*GOAL_COMPLETE\s*:\s*(.+)$/im);
  if (complete) {
    goal.status = "complete";
    goal.lastStatus = complete[1]?.trim() ?? "";
    goal.updatedAt = Date.now();
    return false;
  }

  const blocked = text.match(/^\s*GOAL_BLOCKED\s*:\s*(.+)$/im);
  if (blocked) {
    goal.status = "blocked";
    goal.lastStatus = blocked[1]?.trim() ?? "";
    goal.updatedAt = Date.now();
    return false;
  }

  const cont = text.match(/^\s*GOAL_CONTINUE\s*:\s*(.+)$/im);
  if (cont) goal.lastStatus = cont[1]?.trim() ?? "";
  goal.updatedAt = Date.now();
  return true;
}

function emitLocalCodexResponse(
  ctx: TurnContext,
  content: MessageContent,
  text: string,
  skipPromptPersist: boolean,
) {
  const { session } = ctx;
  if (!skipPromptPersist) {
    ctx.emitEvent({
      type: "user",
      subtype: "prompt",
      message: { role: "user", content },
    });
  }
  session.lastAssistantText = text.slice(-200);
  ctx.emitEvent(assembledAssistant({ text }));
  ctx.emitEvent({
    type: "result",
    subtype: "success",
    result: text,
    harness_duration_ms: Date.now() - session.turnStartedAt,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    num_turns: 0,
    total_cost_usd: 0,
  });
  ctx.updateSessionDb({
    status: "idle",
    messageCount: session.numTurns * 2,
    costUsd: session.costUsd,
    lastPrompt: session.preview,
    lastResponse: text.slice(0, 200),
  });
  session.status = "idle";
}

function handleGoalCommand(
  ctx: TurnContext,
  state: CodexState,
  content: MessageContent,
  skipPromptPersist: boolean,
): { handled: boolean; input?: string } {
  const command = parseGoalCommand(content);
  if (!command) return { handled: false };

  const now = Date.now();
  switch (command.kind) {
    case "set": {
      state.goal = {
        objective: command.objective,
        status: "active",
        iterations: 0,
        startedAt: now,
        updatedAt: now,
      };
      return { handled: true, input: buildGoalPrompt(command.objective) };
    }
    case "status": {
      emitLocalCodexResponse(ctx, content, goalStatusLine(state.goal), skipPromptPersist);
      return { handled: true };
    }
    case "pause": {
      if (state.goal && state.goal.status === "active") {
        state.goal.status = "paused";
        state.goal.updatedAt = now;
      }
      emitLocalCodexResponse(ctx, content, goalStatusLine(state.goal), skipPromptPersist);
      return { handled: true };
    }
    case "clear": {
      state.goal = undefined;
      emitLocalCodexResponse(ctx, content, "Codex goal cleared for this Modus session.", skipPromptPersist);
      return { handled: true };
    }
    case "resume": {
      if (!state.goal) {
        emitLocalCodexResponse(ctx, content, "No Codex goal is set for this Modus session.", skipPromptPersist);
        return { handled: true };
      }
      if (state.goal.status === "complete") {
        emitLocalCodexResponse(ctx, content, goalStatusLine(state.goal), skipPromptPersist);
        return { handled: true };
      }
      state.goal.status = "active";
      state.goal.updatedAt = now;
      return { handled: true, input: buildGoalContinuationPrompt(state.goal) };
    }
  }
}

function buildCodexInput(content: MessageContent, ctx: TurnContext): string {
  const prompt = resolveProfilePrompt(ctx.profile);
  const userInput = contentToString(content);
  if (!prompt?.text) return userInput;

  // Codex CLI does not expose a first-class system prompt or provider preset API.
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

  // Codex CLI supports bearer tokens natively via env var and can pass
  // arbitrary HTTP headers via http_headers config. Use the direct URL
  // instead of routing through the MCP proxy — the proxy's notification
  // handling (202/null body) breaks the rmcp transport in the Codex binary.
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

  const passthroughHeaders = Object.fromEntries(
    Object.entries(config.headers ?? {}).filter(([key]) => key.toLowerCase() !== "authorization"),
  );
  if (Object.keys(passthroughHeaders).length > 0) {
    serverConfig.http_headers = passthroughHeaders;
  }

  return serverConfig;
}

/**
 * Read MCP server configs from a project's .claude/mcp.json, matching the
 * Claude Code provider's project-local discovery path.
 */
function readProjectMcpServers(cwd: string | undefined): Record<string, McpServerConfig> {
  if (!cwd) return {};
  const mcpJsonPath = join(cwd, ".claude", "mcp.json");
  try {
    if (!existsSync(mcpJsonPath)) return {};
    const raw = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    const servers = raw?.mcpServers ?? {};
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
    console.log(`[codex] Discovered project MCP servers at ${mcpJsonPath}: ${Object.keys(servers).join(", ")}`);
    return servers as Record<string, McpServerConfig>;
  } catch (err) {
    console.warn(`[codex] Failed to read ${mcpJsonPath}:`, err);
    return {};
  }
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
  approvalPolicy: ApprovalMode;
  sandboxMode: SandboxMode;
} {
  let approvalPolicy: ApprovalMode = "never";
  let sandboxMode: SandboxMode = "danger-full-access";

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
  sandboxMode?: SandboxMode;
  webSearchMode?: WebSearchMode;
  serviceTier?: ServiceTier;
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
    controls.sandboxMode = (codex as Record<string, SandboxMode>).sandboxMode;
  }
  if (
    (codex as Record<string, unknown>).webSearchMode === "disabled"
    || (codex as Record<string, unknown>).webSearchMode === "cached"
    || (codex as Record<string, unknown>).webSearchMode === "live"
  ) {
    controls.webSearchMode = (codex as Record<string, WebSearchMode>).webSearchMode;
  }
  if (
    (codex as Record<string, unknown>).serviceTier === "standard"
    || (codex as Record<string, unknown>).serviceTier === "fast"
    || (codex as Record<string, unknown>).serviceTier === "priority"
  ) {
    controls.serviceTier = (codex as Record<string, ServiceTier>).serviceTier;
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
    permissionPolicy?: PermissionPolicy;
  },
): {
  approvalPolicy: ApprovalMode;
  sandboxMode: SandboxMode;
  webSearchMode: WebSearchMode;
  serviceTier?: ServiceTier;
} {
  const controls = readCodexProviderControls(opts.providerControls);
  const { approvalPolicy, sandboxMode: derivedSandbox } = mapPermissionPolicy(
    opts.permissionPolicy ?? profileDef?.permissionPolicy,
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

  return { approvalPolicy, sandboxMode, webSearchMode, serviceTier: controls.serviceTier };
}

function codexEnableFeatures(serviceTier?: ServiceTier): string[] {
  return serviceTier === "fast" ? ["goals", "fast_mode"] : ["goals"];
}

function buildCodexConfig(ctx: TurnContext): { config?: CodexConfigObject; env?: Record<string, string> } {
  const { opts, profile } = ctx;
  const projectRoot = ctx.session.projectRoot ?? opts.cwd ?? ctx.session.cwd;
  const globalConfig = getGlobalConfig(projectRoot);
  const projectMcp = readProjectMcpServers(projectRoot ?? process.cwd());
  const mergedMcp = {
    ...projectMcp,
    ...(globalConfig.mcpServers ?? {}),
    ...(profile?.mcpServers ?? {}),
    ...(opts.mcpServers as Record<string, any> ?? {}),
  };
  if (Object.keys(mergedMcp).length === 0) return {};

  console.log(`[codex] MCP merge: projectRoot=${projectRoot} sessionCwd=${ctx.session.cwd} projectMcp=${JSON.stringify(Object.keys(projectMcp))} globalMcp=${JSON.stringify(Object.keys(globalConfig.mcpServers ?? {}))} profileMcp=${JSON.stringify(Object.keys(profile?.mcpServers ?? {}))} sessionMcp=${JSON.stringify(Object.keys(opts.mcpServers ?? {}))}`);

  // Resolve relative --directory args to absolute (same as claude-code provider)
  const harnessRoot = dirname(import.meta.dir.endsWith("/") ? import.meta.dir.slice(0, -1) : import.meta.dir);
  const projectMcpNames = new Set(Object.keys(projectMcp));
  for (const [name, server] of Object.entries(mergedMcp) as [string, any][]) {
    const args = server.args as string[] | undefined;
    if (!args) continue;
    const dirIdx = args.indexOf("--directory");
    const dirVal = dirIdx >= 0 ? args[dirIdx + 1] : undefined;
    if (dirVal && !isAbsolute(dirVal)) {
      const anchor = projectMcpNames.has(name) ? (opts.cwd ?? ctx.session.cwd ?? process.cwd()) : harnessRoot;
      args[dirIdx + 1] = join(anchor, dirVal);
    }
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

      const { approvalPolicy, sandboxMode, webSearchMode, serviceTier } = resolveCodexRuntimeSettings(profileDef, {
        toolStates: opts.toolStates,
        providerControls: opts.providerControls,
      });
      const threadOptions: ThreadOptions = {
        model: opts.model ?? profileDef?.model ?? getCodexSeedModel(),
        workingDirectory: session.cwd ?? opts.cwd ?? process.env.AGENT_CWD ?? process.cwd(),
        skipGitRepoCheck: true,
        sandboxMode,
        approvalPolicy,
        webSearchMode,
        serviceTier,
        additionalDirectories: session.additionalDirectories.length > 0 ? session.additionalDirectories : undefined,
        enableFeatures: codexEnableFeatures(serviceTier),
      };

      // Map effort levels
      threadOptions.modelReasoningEffort = mapCodexReasoningEffort(opts.effort ?? profileDef?.effort);

      // Check if this is a resume
      const requestedResume = !!opts.sessionId && !!getSession(opts.sessionId);
      const isResume = requestedResume && !!opts.sessionId && canResumeCodexThread(opts.sessionId);
      if (requestedResume && opts.sessionId && !isResume) {
        console.warn(`[codex] No local rollout state for ${opts.sessionId}; starting a fresh thread instead of resuming`);
      }

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
      const goalCommand = handleGoalCommand(ctx, state, session.initialContent, false);
      if (goalCommand.handled && !goalCommand.input) return;

      const input = goalCommand.input ? buildCodexInput(goalCommand.input, ctx) : buildCodexInput(session.initialContent, ctx);
      runTurn(ctx, state, input, isResume, false).catch((err) => {
        console.error(`[codex] startTurn error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: String(err) });
        ctx.emitEvent({ type: "done" });
      });

      // Startup timeout
      const abortController = session.abortController;
      setTimeout(() => {
        if (session.status === "starting" && session.abortController === abortController && !state.threadId) {
          const reason = "Session failed to start — no response from Codex within 30s.";
          console.error(`[codex] startup timeout for ${session.sessionId}`);
          session.status = "error";
          session.error = reason;
          abortController.abort();
          ctx.broadcastEvent({ type: "error", error: reason });
          ctx.emitEvent({ type: "done" });
        }
      }, 30_000);
    },

    sendMessage(ctx: TurnContext, content: MessageContent) {
      const { session } = ctx;
      const state = getState(session);

      // session-manager briefly flips idle sessions to "starting" before calling
      // sendMessage so SSE clients don't disconnect during the follow-up handoff.
      // Once Codex has a thread ID, that synthetic "starting" state should not
      // be treated as an active turn or the follow-up will get queued forever.
      if (session.status === "running" || (session.status === "starting" && !state.threadId)) {
        session.pendingDispatch.push(createPendingDispatchItem(content, "next_turn", "sdk"));
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

      const goalCommand = handleGoalCommand(ctx, state, content, true);
      if (goalCommand.handled && !goalCommand.input) return;

      const input = goalCommand.input ? buildCodexInput(goalCommand.input, ctx) : buildCodexInput(content, ctx);
      runTurn(ctx, state, input, true, true).catch((err) => {
        console.error(`[codex] sendMessage error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: String(err) });
        ctx.emitEvent({ type: "done" });
      });
    },

    abort(session: ActiveSession) {
      // Only abort when a turn may be in flight. The Codex CLI wrapper strips the
      // child's 'error' listener in its finally block, so aborting the signal
      // after a turn completes crashes the runtime via an uncaught EventEmitter
      // 'error' from Node's internal abortChildProcess.
      if (session.status !== "running" && session.status !== "starting") return;
      const state = getState(session);
      if (state) state.abortController.abort();
      session.abortController.abort();
    },

    updateConfig(session: ActiveSession, config: Record<string, any>) {
      const state = getState(session);
      if (!state) return;

      if (config.model !== undefined) {
        state.threadOptions.model = config.model || undefined;
      }
      if (config.effort !== undefined) {
        state.threadOptions.modelReasoningEffort = mapCodexReasoningEffort(config.effort);
      }
      state.threadOptions.workingDirectory = session.cwd;
      state.threadOptions.additionalDirectories = session.additionalDirectories.length > 0
        ? session.additionalDirectories
        : undefined;

      const profileDef = session.profile ? getProfile(session.profile, session.cwd) : undefined;
      const runtime = resolveCodexRuntimeSettings(profileDef, {
        toolStates: session._configOverrides.toolStates,
        providerControls: session._configOverrides.providerControls,
      });
      state.threadOptions.approvalPolicy = runtime.approvalPolicy;
      state.threadOptions.sandboxMode = runtime.sandboxMode;
      state.threadOptions.webSearchMode = runtime.webSearchMode;
      state.threadOptions.serviceTier = runtime.serviceTier;
      state.threadOptions.enableFeatures = codexEnableFeatures(runtime.serviceTier);

      if (session.status === "running" || session.status === "starting") {
        session.abortController.abort();
      }
    },

    async dispose(session: ActiveSession) {
      const state = getState(session);
      if (!state) return;
      // Only abort when a turn may be in flight. Aborting after the Codex CLI's
      // child_process has already exited crashes the runtime: the wrapper calls
      // child.removeAllListeners() in its finally, so the subsequent abort's
      // internal 'error' emit has no listener and bubbles up uncaught.
      if (session.status === "running" || session.status === "starting") {
        state.abortController.abort();
      }
      cleanupCodexRulesFile(state.rulesFilePath);
      session._providerState = null;
    },

    switchProfile(session: ActiveSession, ctx: TurnContext, contextMode: string) {
      const state = getState(session);
      if (!state) return;

      // Update thread options for next turn
      state.threadOptions.model = ctx.opts.model || undefined;
      state.threadOptions.modelReasoningEffort = mapCodexReasoningEffort(ctx.opts.effort);
      state.threadOptions.workingDirectory = session.cwd;
      state.threadOptions.additionalDirectories = ctx.opts.additionalDirectories?.length
        ? ctx.opts.additionalDirectories
        : undefined;
      // Update permission policy for next turn
      const runtime = resolveCodexRuntimeSettings(ctx.profile, {
        toolStates: ctx.opts.toolStates,
        providerControls: ctx.opts.providerControls,
      });
      state.threadOptions.approvalPolicy = runtime.approvalPolicy;
      state.threadOptions.sandboxMode = runtime.sandboxMode;
      state.threadOptions.webSearchMode = runtime.webSearchMode;
      state.threadOptions.serviceTier = runtime.serviceTier;
      state.threadOptions.enableFeatures = codexEnableFeatures(runtime.serviceTier);

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
    console.log(`[codex] resuming thread ${state.threadId} for ${session.sessionId}`);
    thread = state.codex.resumeThread(state.threadId, state.threadOptions);
  } else if (state.thread && isResume) {
    // Reuse thread object (same process, multi-turn)
    console.log(`[codex] reusing thread object for ${session.sessionId}`);
    thread = state.thread;
  } else {
    // Fresh thread
    console.log(`[codex] starting fresh thread for ${session.sessionId} (threadId=${state.threadId}, isResume=${isResume})`);
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
              model: state.threadOptions.model ?? getCodexSeedModel(),
              config: {
                provider: ctx.opts.provider ?? "codex",
                model: ctx.opts.model ?? state.threadOptions.model ?? "",
                effort: ctx.opts.effort ?? "",
                maxTurns: ctx.opts.maxTurns,
                toolStates: ctx.opts.toolStates ?? {},
                providerControls: ctx.opts.providerControls ?? {},
              },
              cwd: session.cwd,
              additionalDirectories: session.additionalDirectories,
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
              const todos = ((item.items ?? []) as Array<{ text: string; completed: boolean }>).map((it: { text: string; completed: boolean }, idx: number) => ({
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
    if (state.goal?.status === "active") {
      state.goal.iterations++;
    }
    let continueGoal = updateGoalFromAssistant(state.goal, lastAgentText);
    if (continueGoal && ctx.opts.maxTurns && state.goal && state.goal.iterations >= ctx.opts.maxTurns) {
      state.goal.status = "paused";
      state.goal.lastStatus = `Paused after reaching maxTurns=${ctx.opts.maxTurns}.`;
      state.goal.updatedAt = Date.now();
      continueGoal = false;
    }

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
    // Replace the AbortController now that the turn's child_process has exited.
    // The Codex CLI wrapper strips the child's 'error' listener in its finally block,
    // so aborting the old signal later would crash via an uncaught EventEmitter
    // 'error' from Node's internal abortChildProcess.
    session.abortController = new AbortController();
    state.abortController = session.abortController;

    if (continueGoal && state.goal?.status === "active" && session.pendingDispatch.length === 0) {
      session.initialContent = buildGoalContinuationPrompt(state.goal);
      session.preview = `/goal ${state.goal.objective}`.slice(0, 80);
      session.status = "running";
      session.turnStartedAt = Date.now();
      updateSessionStatus(session.sessionId, "running");

      runTurn(ctx, state, buildCodexInput(session.initialContent, ctx), true, true).catch((err) => {
        console.error(`[codex] goal continuation error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
      });
      return;
    }

    // Flush queued messages
    if (session.pendingDispatch.length > 0) {
      const next = session.pendingDispatch.shift()!.content;
      session.initialContent = next;
      session.preview = typeof next === "string" ? next.slice(0, 80) : "[content]";
      session.abortController = new AbortController();
      state.abortController = session.abortController;
      session.status = "running";
      session.turnStartedAt = Date.now();

      const goalCommand = handleGoalCommand(ctx, state, next, true);
      if (goalCommand.handled && !goalCommand.input) return;
      const nextInput = goalCommand.input ? buildCodexInput(goalCommand.input, ctx) : buildCodexInput(next, ctx);
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
    const isMissingRollout = isResume && String(err).includes("no rollout found for thread id");

    if (isMissingRollout) {
      console.warn("[codex] missing stored rollout for " + session.sessionId + "; restarting as a fresh thread");
      state.thread = null;
      state.threadId = null;
      runTurn(ctx, state, input, false, skipPromptPersist).catch((retryErr) => {
        console.error("[codex] fresh-start retry failed for " + session.sessionId + ":", retryErr);
        session.error = String(retryErr);
        session.status = "error";
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: String(retryErr) });
        ctx.emitEvent({ type: "done" });
      });
      return;
    } else if (isAbort) {
      console.log(`[codex] aborted ${session.sessionId}`);
      session.status = "idle";
      updateSessionStatus(session.sessionId, "idle");
      session.abortController = new AbortController();
      state.abortController = session.abortController;

      ctx.emitEvent({ type: "done" });

      if (session.pendingDispatch.length > 0) {
        const next = session.pendingDispatch.shift()!.content;
        session.initialContent = next;
        session.preview = typeof next === "string" ? next.slice(0, 80) : "[content]";
        session.abortController = new AbortController();
        state.abortController = session.abortController;
        session.status = "running";
        session.turnStartedAt = Date.now();

        const goalCommand = handleGoalCommand(ctx, state, next, true);
        if (goalCommand.handled && !goalCommand.input) return;
        const nextInput = goalCommand.input ? buildCodexInput(goalCommand.input, ctx) : buildCodexInput(next, ctx);
        runTurn(ctx, state, nextInput, true, true).catch((err2) => {
          console.error(`[codex] post-abort drain error for ${session.sessionId}:`, err2);
          session.status = "error";
          session.error = String(err2);
          updateSessionStatus(session.sessionId, "error");
          ctx.emitEvent({ type: "done" });
        });
      }
    } else {
      session.error = String(err);
      session.status = "error";
      updateSessionStatus(session.sessionId, "error");
      ctx.broadcastEvent({ type: "error", error: String(err) });
      ctx.emitEvent({ type: "done" });
    }
  }
}
