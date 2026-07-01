/**
 * Harness Context tests — each capability namespace is exercised against an injected
 * stub engine bundle (buildHarnessContextWith). No global module mocking, so the rest
 * of the suite is untouched. This proves the god-object mitigation: every capability
 * module is isolatable and gating happens at the namespace method boundary.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { buildHarnessContextWith, type HarnessSelf, type HarnessEngines } from "./harness-context";

const calls = {
  spawned: [] as any[],
  sent: [] as any[],
  delivered: [] as any[],
  channels: [] as any[],
  actions: [] as string[],
  scheduled: [] as any[],
  logs: [] as any[],
};

function makeEngines(): HarnessEngines {
  return {
    startSession: (o: any) => { calls.spawned.push(o); return { sessionId: "ses-mock", status: "idle" } as any; },
    interactWithSession: (async (o: any) => { calls.sent.push(o); return { sessionId: o.sessionId, status: "idle", queued: true }; }) as any,
    deliverToSession: (async (target: string, content: string) => { calls.delivered.push({ target, content }); return { delivered: [target], missed: false }; }) as any,
    attachArtifactToSession: ((o: any) => ({ id: 1, sessionId: o.sessionId, seq: o.seq, name: o.name, mime: o.mime, url: "/x", createdAt: 0 })) as any,
    buildMoveDB: (() => ({
      listSessions: () => [{ id: "s1" }],
      getSession: (id: string) => ({ id }),
      searchSessions: () => [],
      getMoveHistory: () => [],
      getSessionMessages: () => [],
    })) as any,
    buildStateApi: (() => ({ get: async () => "PERSISTED", set: async () => {}, delete: async () => {} })) as any,
    watchMoveSessionTurns: (() => () => { /* unsub */ }) as any,
    activateMove: (async () => ({ token: "tok", mode: "inline", moveRunId: 7 })) as any,
    listMoves: (() => [{ name: "m" }]) as any,
    triggerAction: (async (name: string) => { calls.actions.push(name); return true; }) as any,
    scheduleWake: ((req: any) => { calls.scheduled.push(req); return { id: "wake-x", scheduled: true, cancel: () => {} }; }) as any,
    createTerminal: (() => ({ id: "term-mock", proc: { exited: Promise.resolve(0) } })) as any,
    writeTerminal: (() => true) as any,
    killTerminal: (() => true) as any,
    sendToNamedChannel: (async (ch: string, p: any) => { calls.channels.push({ ch, p }); return { ok: true }; }) as any,
    logActivity: ((e: any) => calls.logs.push(e)) as any,
    resolveSecret: (() => "SECRET") as any,
    isSecretSet: (() => true) as any,
    insertSessionArtifact: (() => 42) as any,
    addSessionTag: (() => {}) as any,
    removeSessionTag: (() => {}) as any,
  };
}

function self(overrides: Partial<HarnessSelf> = {}): HarnessSelf {
  return {
    kind: "move",
    name: "test-move",
    sessionId: "ses-caller",
    caller: "agent",
    cwd: "/tmp/proj",
    userProfile: "u",
    trust: "builtin",
    ...overrides,
  };
}

const ctx = (overrides: Partial<HarnessSelf> = {}) => buildHarnessContextWith(self(overrides), makeEngines());

beforeEach(() => {
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k].length = 0;
});

describe("composition", () => {
  test("exposes every capability namespace", () => {
    const c = ctx();
    for (const ns of ["sessions", "channels", "moves", "actions", "state", "db", "secrets", "shell", "artifacts", "terminal"] as const) {
      expect(c[ns]).toBeDefined();
    }
    expect(typeof c.log).toBe("function");
    expect(c.self.name).toBe("test-move");
  });
});

describe("sessions", () => {
  test("create spawns via the engine and returns the id", async () => {
    const id = await ctx().sessions.create({ profile: "p", prompt: "hi" });
    expect(id).toBe("ses-mock");
    expect(calls.spawned[0]).toMatchObject({ profile: "p", prompt: "hi", cwd: "/tmp/proj" });
  });

  test("send routes through interactWithSession (createIfMissing:false)", async () => {
    await ctx().sessions.send("ses-x", "yo");
    expect(calls.sent[0]).toMatchObject({ sessionId: "ses-x", prompt: "yo", createIfMissing: false });
  });

  test("wake 'now' delivers immediately and returns an unscheduled handle", async () => {
    const h = await ctx().sessions.wake("role:worker", "task");
    expect(h.scheduled).toBe(false);
    expect(h.delivered).toEqual(["role:worker"]);
    expect(calls.delivered[0]).toMatchObject({ target: "role:worker", content: "task" });
  });

  test("wake with {every} delegates to the scheduler", async () => {
    const h = await ctx().sessions.wake("role:worker", "task", { every: "30m" });
    expect(h.scheduled).toBe(true);
    expect(calls.scheduled[0]).toMatchObject({ target: "role:worker", content: "task", when: { every: "30m" } });
  });

  test("get/list delegate to the read-only move DB", () => {
    expect(ctx().sessions.get("abc")).toEqual({ id: "abc" } as any);
    expect(ctx().sessions.list()).toEqual([{ id: "s1" }] as any);
  });
});

describe("channels (egress primitive)", () => {
  test("send resolves a named channel and dispatches", async () => {
    const res = await ctx().channels.send("team", { text: "shipped" });
    expect(res.ok).toBe(true);
    expect(calls.channels[0]).toMatchObject({ ch: "team", p: { text: "shipped" } });
  });
});

describe("moves / actions", () => {
  test("moves.activate delegates and unwraps the result", async () => {
    const r = await ctx().moves.activate({ moveName: "x" });
    expect(r).toMatchObject({ token: "tok", mode: "inline", moveRunId: 7 });
  });
  test("actions.trigger delegates by name", async () => {
    await ctx().actions.trigger("nightly");
    expect(calls.actions).toEqual(["nightly"]);
  });
});

describe("state", () => {
  test("no instance bound → NOOP state", async () => {
    expect(await ctx().state.get()).toBeUndefined();
  });
  test("instance bound → real state API", async () => {
    expect(await ctx({ instanceId: "inst-1", statePersist: true }).state.get<string>()).toBe("PERSISTED");
  });
});

describe("gating at the namespace boundary", () => {
  test("builtin trust bypasses capability checks", async () => {
    const c = ctx({ trust: "builtin", capabilities: { sessionSpawn: false } });
    await expect(c.sessions.create({ profile: "p", prompt: "x" })).resolves.toBe("ses-mock");
  });

  test("reviewed trust throws when the capability is explicitly false", async () => {
    const c = ctx({ trust: "reviewed", capabilities: { sessionSpawn: false } });
    await expect(c.sessions.create({ profile: "p", prompt: "x" })).rejects.toThrow(/sessionSpawn: false/);
  });

  test("reviewed trust allows when the capability is not denied", async () => {
    const c = ctx({ trust: "reviewed", capabilities: { notify: true } });
    await expect(c.channels.send("team", { text: "ok" })).resolves.toMatchObject({ ok: true });
  });

  test("experimental trust logs a warning but does not block", async () => {
    const c = ctx({ trust: "experimental", capabilities: { notify: false } });
    const res = await c.channels.send("team", { text: "still goes" });
    expect(res.ok).toBe(true);
    expect(calls.logs.some((l) => l.eventType === "harness_capability_warning")).toBe(true);
  });

  test("reviewed trust blocks actionTrigger when denied", async () => {
    const c = ctx({ trust: "reviewed", capabilities: { actionTrigger: false } });
    await expect(c.actions.trigger("x")).rejects.toThrow(/actionTrigger: false/);
    expect(calls.actions).toEqual([]);
  });
});

describe("artifacts / terminal", () => {
  test("artifacts.insert delegates to the engine", () => {
    expect(ctx().artifacts.insert({ sessionId: "s", name: "n", mime: "image/png", path: "/p" })).toBe(42);
  });
  test("terminal.create returns a handle backed by the engine", () => {
    expect(ctx().terminal.create().id).toBe("term-mock");
  });
});
