import { existsSync } from "fs";
import type { MoveApiContext, MoveApiHandler, MoveContext } from "../../../harness/move-types";
import { startSession } from "../../session-manager";
import { getAllUserProfiles } from "../../profiles";

type Direction = "caller-to-target" | "target-to-caller";

type ProjectCall = {
  callId: string;
  title: string;
  sourceCwd: string;
  targetCwd: string;
  callerSessionId: string;
  targetSessionId: string;
  targetProfile: string;
  remainingMessages: number;
  createdAt: string;
  updatedAt: string;
  transcript: Array<{
    direction: Direction | "initial";
    message: string;
    at: string;
  }>;
};

type ProjectCallState = {
  calls: Record<string, ProjectCall>;
};

function inputString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function inputNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newCallId(): string {
  return `pcall-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveProfile(value: string, fallbackProfile?: string): string {
  if (value && value !== "Current profile") return value;
  return fallbackProfile ?? "modus-helper";
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function resolveTargetProjectOwner(targetCwd: string): { userProfile?: string; defaultAgent?: string } {
  const target = normalizePath(targetCwd);
  for (const [name, up] of Object.entries(getAllUserProfiles())) {
    for (const proj of up.projects ?? []) {
      if (normalizePath(proj) === target) {
        return { userProfile: name, defaultAgent: up.defaultAgentProfile };
      }
    }
  }
  return {};
}

function sessionMatchesProject(sessionCwd: string | undefined, projectCwd: string): boolean {
  const sessionPath = normalizePath(sessionCwd ?? "");
  const projectPath = normalizePath(projectCwd);
  if (!sessionPath || !projectPath) return false;
  return sessionPath === projectPath || sessionPath.startsWith(`${projectPath}/`);
}

function emptyState(): ProjectCallState {
  return { calls: {} };
}

function buildInitialMessage(args: {
  sourceCwd: string;
  title: string;
  message: string;
  apiToken: string;
  callId: string;
  remainingMessages: number;
}): string {
  return [
    `[PROJECT CALL] ${args.title}`,
    "",
    `Source project: ${args.sourceCwd}`,
    `Call id: ${args.callId}`,
    `Remaining message budget after this initial call: ${args.remainingMessages}`,
    "",
    "To reply, use `modus_submit` with this token:",
    args.apiToken,
    "",
    "Submit:",
    `{ "op": "message", "callId": "${args.callId}", "direction": "target-to-caller", "message": "..." }`,
    "",
    args.message,
  ].join("\n");
}

export async function gather(ctx: MoveContext): Promise<string> {
  const targetCwd = inputString(ctx.inputs.targetCwd);
  const targetSessionId = inputString(ctx.inputs.targetSessionId);
  const targetProfile = inputString(ctx.inputs.targetProfile);
  const message = inputString(ctx.inputs.message);
  const budget = inputNumber(ctx.inputs.budget, 1);

  return [
    "You are running the project-call move.",
    "",
    "This is a bidirectional project protocol. You have an API token for the call.",
    "",
    `API token: ${ctx.apiToken}`,
    "",
    "Use these values unless the user explicitly changes them:",
    `- targetCwd: ${targetCwd || "(missing)"}`,
    `- targetSessionId: ${targetSessionId || "(new session)"}`,
    `- targetProfile: ${targetProfile || "Current profile"}`,
    `- budget: ${budget}`,
    "",
    "Message:",
    message,
    "",
    "Rules:",
    "- Call `modus_submit` with op `call` to start the protocol.",
    "- If targetSessionId is present, the initial message is sent there.",
    "- If targetSessionId is blank, a new target session is spawned in targetCwd.",
    "- The target agent receives this same API token and a callId so it can call back.",
    "- Each follow-up message uses op `message` and consumes one budget unit. Default budget is 1, so the target can answer once.",
    "- Do not perform extra work in the target project yourself.",
    "",
    "Initial call payload:",
    `{ "op": "call", "targetCwd": "${targetCwd}", "targetSessionId": "${targetSessionId}", "targetProfile": "${targetProfile}", "budget": ${budget}, "message": ${JSON.stringify(message)} }`,
  ].join("\n");
}

export const handlers: Record<string, MoveApiHandler> = {
  call: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const targetCwd = inputString(data.targetCwd);
    const targetSessionIdInput = inputString(data.targetSessionId);
    const rawProfile = inputString(data.targetProfile);
    const message = inputString(data.message);
    const title = inputString(data.title) || "Message from another Modus project";
    const remainingMessages = Math.max(0, Math.floor(inputNumber(data.budget, 1)));

    if (!targetCwd) return { ok: false, error: "targetCwd is required" };
    if (!message) return { ok: false, error: "message is required" };
    if (!existsSync(targetCwd)) return { ok: false, error: `targetCwd does not exist: ${targetCwd}` };
    if (!ctx.sessionId) return { ok: false, error: "caller session is required" };

    const state = await ctx.state.get<ProjectCallState>() ?? emptyState();
    const callId = newCallId();
    const owner = resolveTargetProjectOwner(targetCwd);
    const callerProfile = ctx.db.getSession(ctx.sessionId)?.profile ?? undefined;
    let targetProfile = resolveProfile(rawProfile, owner.defaultAgent ?? callerProfile);
    const initial = buildInitialMessage({
      sourceCwd: ctx.cwd,
      title,
      message,
      apiToken: `mapi-project-call-${ctx.instanceId}`,
      callId,
      remainingMessages,
    });

    let targetSessionId = targetSessionIdInput;
    if (targetSessionId) {
      const existing = ctx.db.getSession(targetSessionId);
      if (!existing) return { ok: false, error: `targetSessionId not found: ${targetSessionId}` };
      if (!sessionMatchesProject(existing.cwd ?? undefined, targetCwd)) {
        return { ok: false, error: `targetSessionId ${targetSessionId} is not in targetCwd ${targetCwd}` };
      }
      targetProfile = existing.profile ?? targetProfile;
      await ctx.sendMessage(targetSessionId, initial);
    } else {
      const session = startSession({
        profile: targetProfile,
        userProfile: owner.userProfile,
        prompt: initial,
        cwd: targetCwd,
        tags: ["project-call", `project-call:${callId}`],
      });

      const startedAt = Date.now();
      while (session.status === "starting" && Date.now() - startedAt < 8000) {
        await Bun.sleep(100);
      }
      targetSessionId = session.sessionId;
    }

    const timestamp = nowIso();
    state.calls[callId] = {
      callId,
      title,
      sourceCwd: ctx.cwd,
      targetCwd,
      callerSessionId: ctx.sessionId,
      targetSessionId,
      targetProfile,
      remainingMessages,
      createdAt: timestamp,
      updatedAt: timestamp,
      transcript: [{ direction: "initial", message, at: timestamp }],
    };
    await ctx.state.set(state);

    return {
      ok: true,
      message: `Project call ${callId} started. Target session: ${targetSessionId}. Remaining message budget: ${remainingMessages}.`,
    };
  },

  message: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const callId = inputString(data.callId);
    const direction = inputString(data.direction) as Direction;
    const message = inputString(data.message);

    if (!callId) return { ok: false, error: "callId is required" };
    if (direction !== "caller-to-target" && direction !== "target-to-caller") {
      return { ok: false, error: "direction must be caller-to-target or target-to-caller" };
    }
    if (!message) return { ok: false, error: "message is required" };

    const state = await ctx.state.get<ProjectCallState>() ?? emptyState();
    const call = state.calls[callId];
    if (!call) return { ok: false, error: `Unknown callId: ${callId}` };
    if (call.remainingMessages <= 0) return { ok: false, error: `Message budget exhausted for ${callId}` };

    const targetSessionId = direction === "target-to-caller"
      ? call.callerSessionId
      : call.targetSessionId;
    const sender = direction === "target-to-caller" ? "target project" : "caller project";
    const receiverDirection = direction === "target-to-caller" ? "caller-to-target" : "target-to-caller";
    const nextRemaining = call.remainingMessages - 1;
    const delivered = [
      `[PROJECT CALL MESSAGE] ${call.title}`,
      "",
      `Call id: ${call.callId}`,
      `From: ${sender}`,
      `Remaining message budget after this message: ${nextRemaining}`,
      "",
      nextRemaining > 0
        ? [
            "To answer, use `modus_submit` with:",
            `{ "op": "message", "callId": "${call.callId}", "direction": "${receiverDirection}", "message": "..." }`,
          ].join("\n")
        : "Message budget is now exhausted.",
      "",
      message,
    ].join("\n");

    await ctx.sendMessage(targetSessionId, delivered);

    call.remainingMessages = nextRemaining;
    call.updatedAt = nowIso();
    call.transcript.push({ direction, message, at: call.updatedAt });
    await ctx.state.set(state);

    return {
      ok: true,
      message: `Delivered ${direction} message for ${callId}. Remaining message budget: ${nextRemaining}.`,
    };
  },

  status: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const callId = inputString(data.callId);
    if (!callId) return { ok: false, error: "callId is required" };

    const state = await ctx.state.get<ProjectCallState>() ?? emptyState();
    const call = state.calls[callId];
    if (!call) return { ok: false, error: `Unknown callId: ${callId}` };

    return { ok: true, message: JSON.stringify(call, null, 2) };
  },
};
