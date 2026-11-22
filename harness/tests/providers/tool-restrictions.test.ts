import { describe, expect, test } from "bun:test";
import {
  decideTool,
  describeToolRestriction,
  isMcpToolName,
  noticeToolDenied,
  toolEntryMatches,
  toolRestriction,
  toolRestrictionConfig,
  type ToolRestrictionConfig,
} from "../../providers/tool-restrictions";
import { ANTIGRAVITY_TOOL_ALIASES } from "../../providers/antigravity-capabilities";
import { GROK_BUILD_TOOL_ALIASES } from "../../providers/grok-build-capabilities";
import { MUSE_CODE_TOOL_ALIASES } from "../../providers/muse-code-capabilities";

/** The tools list of a real Claude-authored profile that broke Antigravity and Grok. */
const CLAUDE_PROFILE_TOOLS = [
  "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "Bash", "PowerShell", "WebSearch", "WebFetch",
  "Skill", "ToolSearch", "ScheduleWakeup", "Monitor", "AskUserQuestion", "PushNotification",
];

function config(overrides: Partial<ToolRestrictionConfig> = {}): ToolRestrictionConfig {
  return { disallowedTools: [], toolStates: {}, policy: "bypass", ...overrides };
}

function ctxWith(fields: {
  profile?: Record<string, unknown>;
  opts?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}): any {
  return {
    session: { _configOverrides: fields.overrides ?? {}, sessionApprovals: new Set<string>() },
    opts: fields.opts ?? {},
    profile: fields.profile,
  };
}

describe("shared tool restrictions", () => {
  test("a Claude-authored tools list allows every Antigravity tool it names", () => {
    const allowed = config({ tools: CLAUDE_PROFILE_TOOLS });
    for (const tool of ["run_command", "manage_task", "read_file", "write_file", "edit_file", "search_web", "schedule", "ask_question"]) {
      expect(toolRestriction(tool, allowed, ANTIGRAVITY_TOOL_ALIASES)).toBeNull();
    }
    // Agent and Workflow are not in that profile, so subagents and workflows stay off.
    expect(toolRestriction("invoke_subagent", allowed, ANTIGRAVITY_TOOL_ALIASES)?.kind).toBe("allowlist");
    expect(toolRestriction("run_workflow", allowed, ANTIGRAVITY_TOOL_ALIASES)?.kind).toBe("allowlist");
    expect(toolRestriction("run_workflow", config({ disallowedTools: ["Workflow"] }), ANTIGRAVITY_TOOL_ALIASES))
      .toEqual({ kind: "disallowed", entry: "Workflow" });
    expect(toolRestriction("run_workflow", config({ tools: ["Workflow"] }), ANTIGRAVITY_TOOL_ALIASES)).toBeNull();
  });

  test("the same list allows the Grok Build and Muse Code tools it names", () => {
    const allowed = config({ tools: CLAUDE_PROFILE_TOOLS });
    for (const tool of ["run_terminal_cmd", "read_file", "write_file", "search_replace", "list_dir", "grep_search", "web_search", "web_fetch", "monitor", "ask_user_question"]) {
      expect(toolRestriction(tool, allowed, GROK_BUILD_TOOL_ALIASES)).toBeNull();
    }
    expect(toolRestriction("task", allowed, GROK_BUILD_TOOL_ALIASES)?.kind).toBe("allowlist");
    for (const tool of ["shell", "read_file", "write_file"]) {
      expect(toolRestriction(tool, allowed, MUSE_CODE_TOOL_ALIASES)).toBeNull();
    }
  });

  test("MCP tools are outside the allowlist but obey disallowedTools in either spelling", () => {
    expect(isMcpToolName("mcp_echo_echo")).toBe(true);
    expect(isMcpToolName("modus_submit")).toBe(true);
    expect(isMcpToolName("read_file")).toBe(false);
    expect(toolRestriction("mcp_echo_echo", config({ tools: ["Read"] }), ANTIGRAVITY_TOOL_ALIASES)).toBeNull();
    expect(toolEntryMatches("mcp__echo__echo", "mcp_echo_echo", undefined)).toBe(true);
    expect(toolEntryMatches("mcp__echo", "mcp_echo_echo", undefined)).toBe(true);
    expect(toolEntryMatches("mcp__echo", "mcp__echo__ping", undefined)).toBe(true);
    expect(toolEntryMatches("mcp__echo", "mcp_other_echo", undefined)).toBe(false);
    expect(toolRestriction("mcp_echo_echo", config({ disallowedTools: ["mcp__echo"] }), undefined)).toEqual({ kind: "disallowed", entry: "mcp__echo" });
  });

  test("a tool switched on overrides the allowlist; switched off wins over everything", () => {
    const aliases = ANTIGRAVITY_TOOL_ALIASES;
    expect(toolRestriction("write_file", config({ tools: ["Read"], toolStates: { Write: "on" } }), aliases)).toBeNull();
    expect(toolRestriction("write_file", config({ tools: ["Read"], toolStates: { write_file: "on" } }), aliases)).toBeNull();
    expect(toolRestriction("read_file", config({ tools: ["Read"], toolStates: { Read: "off" } }), aliases)).toEqual({ kind: "toggled-off", entry: "Read" });
    expect(toolRestriction("run_command", config({ disallowedTools: ["PowerShell"] }), aliases)).toEqual({ kind: "disallowed", entry: "PowerShell" });
  });

  test("a toggle on the tool's own name wins over one on a shared name, as the tool grid shows it", () => {
    const aliases = ANTIGRAVITY_TOOL_ALIASES;
    expect(toolRestriction("run_command", config({ toolStates: { Bash: "off", run_command: "on" } }), aliases)).toBeNull();
    expect(toolRestriction("run_command", config({ toolStates: { Bash: "on", PowerShell: "off" } }), aliases)?.kind).toBe("toggled-off");
    expect(toolRestriction("run_command", config({ tools: ["Read"], toolStates: { Bash: "on" } }), aliases)).toBeNull();
  });

  test("session overrides win over turn options, which win over the profile", () => {
    const resolved = toolRestrictionConfig(ctxWith({
      profile: { tools: ["Read"], disallowedTools: ["Write"], permissionPolicy: "ask" },
      opts: { tools: ["Bash"], disallowedTools: ["Edit"], permissionPolicy: "auto-edit" },
      overrides: { tools: ["WebSearch"], disallowedTools: ["Agent"], toolStates: { Read: "off" }, permissionPolicy: "bypass" },
    }));
    expect(resolved).toEqual({
      tools: ["WebSearch"],
      disallowedTools: ["Write", "Edit", "Agent"],
      toolStates: { Read: "off" },
      policy: "bypass",
    });
  });

  test("permission policy name lists accept shared names", () => {
    const session: any = { sessionApprovals: new Set<string>() };
    const policy = { default: "approve" as const, requireApproval: ["Bash"], autoApprove: ["Write"] };
    const options = { aliases: ANTIGRAVITY_TOOL_ALIASES, shellTools: new Set(["run_command"]) };
    expect(decideTool(session, "run_command", config({ policy }), options).decision).toBe("ask");
    expect(decideTool(session, "write_file", config({ policy }), options).decision).toBe("allow");
    expect(decideTool(session, "run_command", config({ policy: "auto-edit" }), options).decision).toBe("ask");
    session.sessionApprovals.add("run_command");
    expect(decideTool(session, "run_command", config({ policy: "ask" }), options).decision).toBe("allow");
  });

  test("explains a denial with the setting and the names that would allow the tool", () => {
    const message = describeToolRestriction("run_command", { kind: "allowlist", allowed: ["Read", "Write"] }, ANTIGRAVITY_TOOL_ALIASES);
    expect(message).toBe(
      "Modus blocked `run_command`: this session's tools list (Read, Write) does not include it. "
        + "Add Bash or PowerShell (or `run_command`) to the profile's tools, or switch it on in the session's tool settings.",
    );
    expect(describeToolRestriction("write_file", { kind: "disallowed", entry: "Write" }, ANTIGRAVITY_TOOL_ALIASES))
      .toBe("Modus blocked `write_file`: `Write` is in disallowedTools.");
    expect(describeToolRestriction("foo", { kind: "allowlist", allowed: CLAUDE_PROFILE_TOOLS }, undefined))
      .toContain("(Read, Write, Edit, NotebookEdit, Glob, Grep, …)");
  });

  test("emits each denial as one visible transcript line per turn", () => {
    const events: any[] = [];
    const ctx: any = { emitEvent: (event: any) => events.push(event) };
    const noticed = new Set<string>();
    const restriction = { kind: "allowlist" as const, allowed: ["Read"] };
    noticeToolDenied(ctx, noticed, "run_command", restriction, { toolAliases: ANTIGRAVITY_TOOL_ALIASES });
    noticeToolDenied(ctx, noticed, "run_command", restriction, { toolAliases: ANTIGRAVITY_TOOL_ALIASES });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "system", subtype: "provider_message", severity: "warning" });
    expect(events[0].content).toStartWith("warning: Modus blocked `run_command`");
  });
});

describe("Grok Build native tool flags", () => {
  test("resolve shared names to Grok tools instead of disabling every tool", async () => {
    const { grokToolArgs } = await import("../../providers/grok-build");
    const args = grokToolArgs(ctxWith({ profile: { tools: ["Read", "Bash"] } }));
    const allowed = args[args.indexOf("--tools") + 1]!.split(",");
    const denied = args[args.indexOf("--disallowed-tools") + 1]!.split(",");
    expect(allowed.sort()).toEqual(["read_file", "run_terminal_cmd", "run_terminal_command"]);
    expect(denied).toContain("write_file");
    expect(denied).not.toContain("read_file");
    expect(denied).not.toContain("run_terminal_cmd");
  });

  test("pass entries they do not know through, and add nothing when unrestricted", async () => {
    const { grokToolArgs } = await import("../../providers/grok-build");
    expect(grokToolArgs(ctxWith({}))).toEqual([]);
    const newer = grokToolArgs(ctxWith({ profile: { tools: ["Read", "video_studio"] } }));
    expect(newer[newer.indexOf("--tools") + 1]!.split(",").sort()).toEqual(["read_file", "video_studio"]);
    expect(grokToolArgs(ctxWith({ profile: { disallowedTools: ["Write", "mcp__db__drop"] } })))
      .toEqual(["--disallowed-tools", "write_file,mcp__db__drop"]);
    const webOff = grokToolArgs(ctxWith({ overrides: { toolStates: { WebSearch: "off" } } }));
    expect(webOff[0]).toBe("--disallowed-tools");
    expect(webOff[1]!.split(",").sort()).toEqual(["web_search", "x_keyword_search", "x_search", "x_semantic_search", "x_user_search"]);
  });

  test("decides permission requests by shared names", async () => {
    const { toolDecision } = await import("../../providers/grok-build");
    const ctx = ctxWith({ profile: { tools: ["Read", "Bash"], permissionPolicy: "bypass" } });
    expect(toolDecision(ctx, "run_terminal_cmd")).toBe("allow");
    expect(toolDecision(ctx, "write_file")).toBe("deny");
  });
});

describe("Muse Code tool decisions", () => {
  test("read a Claude-authored tools list through Muse's names", async () => {
    const { toolDecision } = await import("../../providers/muse-code");
    const ctx = ctxWith({ profile: { tools: ["Read", "Bash"] } });
    expect(toolDecision(ctx, "shell")).toBe("allow");
    expect(toolDecision(ctx, "read_file")).toBe("allow");
    expect(toolDecision(ctx, "write_file")).toBe("deny");
  });
});
