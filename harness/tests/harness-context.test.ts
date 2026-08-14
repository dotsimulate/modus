/**
 * Harness Context tests — each capability namespace is exercised against an injected
 * stub engine bundle (buildHarnessContextWith). No global module mocking, so the rest
 * of the suite is untouched. This proves the god-object mitigation: every capability
 * module is isolatable and gating happens at the namespace method boundary.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { buildHarnessContextWith, type HarnessSelf, type HarnessEngines } from "../harness-context";

const calls = {
  spawned: [] as any[],
  sent: [] as any[],
  delivered: [] as any[],
  channels: [] as any[],
  actions: [] as string[],
  scheduled: [] as any[],
  logs: [] as any[],
  oneShots: [] as any[],
  promotions: [] as any[],
};

/** One-shot records the stub engine hands back to model.promote(). */
const oneShotRecords = new Map<string, any>();

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
    runOneShot: (async (req: any) => {
      calls.oneShots.push(req);
      return { text: "ONE SHOT", oneShotId: "os-stub", provider: "ollama", model: "m", usage: { input: 1, output: 1, totalTokens: 2, costUsd: 0 } };
    }) as any,
    getOneShotRecord: ((id: string) => oneShotRecords.get(id)) as any,
    listOneShotRecords: (() => Array.from(oneShotRecords.values())) as any,
    recordOneShotPromotion: ((id: string, sessionId: string) => {
      calls.promotions.push({ id, sessionId });
      const record = oneShotRecords.get(id);
      if (record) record.promotedSessionId = sessionId;
    }) as any,
  };
}

function stubOneShot(overrides: Record<string, unknown> = {}) {
  const record = {
    id: "os-1",
    createdAt: 0,
    profile: "cleanup",
    provider: "ollama",
    model: "qwen",
    prompt: "punctuate this",
    text: "Punctuated this.",
    origin: { kind: "move", name: "t", cwd: "/orig-proj", userProfile: "orig-user" },
    ...overrides,
  };
  oneShotRecords.set(record.id, record);
  return record;
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
  oneShotRecords.clear();
});

describe("composition", () => {
  test("exposes every capability namespace", () => {
    const c = ctx();
    for (const ns of ["sessions", "channels", "moves", "actions", "model", "state", "db", "secrets", "shell", "artifacts", "terminal"] as const) {
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

describe("model (one-shot completions)", () => {
  test("complete delegates and stamps the caller as the origin", async () => {
    const result = await ctx().model.complete({ prompt: "punctuate this", profile: "cleanup" });
    expect(result.text).toBe("ONE SHOT");
    expect(result.oneShotId).toBe("os-stub");
    expect(calls.oneShots).toHaveLength(1);
    expect(calls.oneShots[0].prompt).toBe("punctuate this");
    expect(calls.oneShots[0].profile).toBe("cleanup");
    // Origin is what lets promote() spawn into the right project later.
    expect(calls.oneShots[0].origin).toMatchObject({ kind: "move", name: "test-move", cwd: "/tmp/proj", userProfile: "u" });
  });

  test("complete is audited with the target and the cost", async () => {
    await ctx().model.complete({ prompt: "x", profile: "cleanup" });
    const entry = calls.logs.find((l) => l.eventType === "harness_model_oneshot");
    expect(entry).toBeDefined();
    expect(entry.metadata).toMatchObject({ provider: "ollama", model: "m", oneShotId: "os-stub", totalTokens: 2 });
  });

  test("promote spawns a session seeded with the replayed exchange", async () => {
    stubOneShot();
    const { sessionId } = await ctx().model.promote("os-1");
    expect(sessionId).toBe("ses-mock");
    expect(calls.spawned).toHaveLength(1);
    // Same profile, and the original project — not the promoting caller's cwd.
    expect(calls.spawned[0].profile).toBe("cleanup");
    expect(calls.spawned[0].cwd).toBe("/orig-proj");
    expect(calls.spawned[0].prompt).toContain("punctuate this");
    expect(calls.spawned[0].prompt).toContain("Punctuated this.");
    expect(calls.promotions).toEqual([{ id: "os-1", sessionId: "ses-mock" }]);
  });

  test("promote is idempotent — a double click does not cost two sessions", async () => {
    stubOneShot();
    const first = await ctx().model.promote("os-1");
    const second = await ctx().model.promote("os-1");
    expect(second.sessionId).toBe(first.sessionId);
    expect(calls.spawned).toHaveLength(1);
  });

  test("promote overrides the user profile when asked, keeping the origin's project", async () => {
    stubOneShot();
    await ctx().model.promote("os-1", { userProfile: "other-user", tags: ["internal"] });
    expect(calls.spawned[0].userProfile).toBe("other-user");
    expect(calls.spawned[0].tags).toEqual(["internal"]);
  });

  test("promoting an unknown id explains that the ring is bounded", async () => {
    await expect(ctx().model.promote("os-gone")).rejects.toThrow(/aged out of the ring|backend restarted/);
    expect(calls.spawned).toHaveLength(0);
  });

  test("promoting a profileless one-shot fails instead of guessing a profile", async () => {
    stubOneShot({ profile: undefined });
    await expect(ctx().model.promote("os-1")).rejects.toThrow(/named no agent profile/);
    expect(calls.spawned).toHaveLength(0);
  });

  test("recent delegates to the record store", async () => {
    stubOneShot();
    expect(ctx().model.recent()).toHaveLength(1);
  });

  test("reviewed trust blocks modelCall when denied, and does not reach the model", async () => {
    const c = ctx({ trust: "reviewed", capabilities: { modelCall: false } });
    await expect(c.model.complete({ prompt: "x", profile: "cleanup" })).rejects.toThrow(/modelCall: false/);
    expect(calls.oneShots).toHaveLength(0);
  });

  test("modelCall denial does not also forbid promoting an existing one-shot", async () => {
    stubOneShot();
    const c = ctx({ trust: "reviewed", capabilities: { modelCall: false } });
    const { sessionId } = await c.model.promote("os-1");
    expect(sessionId).toBe("ses-mock");
  });

  test("promote is gated by sessionSpawn, since spawning is what it does", async () => {
    stubOneShot();
    const c = ctx({ trust: "reviewed", capabilities: { sessionSpawn: false } });
    await expect(c.model.promote("os-1")).rejects.toThrow(/sessionSpawn: false/);
    expect(calls.spawned).toHaveLength(0);
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
