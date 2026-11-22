import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mock } from "bun:test";
import type { TurnContext, SessionProvider } from "../../providers/types";

const cwd = join(process.env.MODUS_HOME!, "fixture-project");
mkdirSync(cwd, { recursive: true });

let context: TurnContext;
const updateConfigCalls: Record<string, unknown>[] = [];
const fakeProvider = {
  capabilities: { name: "antigravity", family: "antigravity" } as any,
  startTurn(ctx: TurnContext) {
    context = ctx;
    ctx.session.status = "idle";
    ctx.emitEvent({
      type: "system",
      subtype: "init",
      session_id: ctx.session.sessionId,
      model: "gemini-4-hydrogen-high",
      config: {
        provider: "antigravity",
        model: "gemini-4-hydrogen-high",
        effort: "high",
        maxTurns: 12,
        toolStates: { Bash: "off" },
        providerControls: { antigravity: { mode: "default", sandbox: true } },
        permissionPolicy: "ask",
      },
      cwd: ctx.session.cwd,
      additionalDirectories: ctx.session.additionalDirectories,
      loadProjectSettings: true,
    });
  },
  sendMessage() {},
  abort() {},
  updateConfig(_session, config) {
    updateConfigCalls.push(config);
  },
} as SessionProvider;
mock.module("../../providers/registry", () => ({ getProvider: () => fakeProvider }));

const { startSessionWithMoves, subscribe, shutdownAll } = await import("../../session-manager");
const { getStoredSessionConfig, db } = await import("../../db");
const { createInitialState, reduceEvent } = await import("../../ui/src/eventReducer");

try {
  const session = await startSessionWithMoves({
    sessionId: "cfg-preserve-session",
    cwd,
    prompt: "hello",
    provider: "antigravity",
    model: "gemini-4-hydrogen",
    effort: "high",
    maxTurns: 12,
    toolStates: { Bash: "off" },
    providerControls: { antigravity: { mode: "default", sandbox: true } },
    permissionPolicy: "ask",
  });
  const deadline = Date.now() + 5_000;
  while (!context! && Date.now() < deadline) await Bun.sleep(10);
  assert.ok(context!, "provider startTurn ran");

  const live: any[] = [];
  subscribe(session.sessionId, {
    async write(_event: string, data: string) { live.push(JSON.parse(data)); },
    close() {},
  });

  // Provider-initiated mode update while idle must NOT call provider.updateConfig
  // back (which would trigger an endless restart loop) and must preserve every
  // other persisted config field.
  context!.notifyConfigChange({
    providerControls: { antigravity: { mode: "plan", sandbox: true } },
  });

  assert.equal(updateConfigCalls.length, 0, "notifyConfigChange must not loop back to provider.updateConfig");

  const stored = getStoredSessionConfig(session.sessionId);
  assert.equal(stored?.provider, "antigravity");
  assert.equal(stored?.effort, "high");
  assert.equal(stored?.maxTurns, 12);
  assert.deepEqual(stored?.toolStates, { Bash: "off" });
  assert.equal(stored?.permissionPolicy, "ask");
  assert.deepEqual(stored?.providerControls, { antigravity: { mode: "plan", sandbox: true } });

  const broadcast = live.find((event) => event.subtype === "config_updated");
  assert.ok(broadcast, "notifyConfigChange broadcasts config_updated to live subscribers");
  const reduced = reduceEvent(createInitialState(session.sessionId), broadcast, 10);
  assert.equal(reduced.agentConfig.provider, "antigravity");
  assert.equal(reduced.agentConfig.effort, "high");
  assert.equal(reduced.agentConfig.maxTurns, "12");
  assert.deepEqual(reduced.agentConfig.toolStates, { Bash: "off" });
  assert.equal(reduced.agentConfig.permissionPolicy, "ask");
  assert.deepEqual(reduced.agentConfig.providerControls, { antigravity: { mode: "plan", sandbox: true } });

  await shutdownAll();
  db.close();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
